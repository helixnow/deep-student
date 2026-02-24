use super::*;

impl ChatV2Pipeline {
    // ========================================================================
    // 多模型并行变体执行 (Prompt 5)
    // ========================================================================

    /// 最大变体数限制（默认值）
    const DEFAULT_MAX_VARIANTS: u32 = 10;

    /// 多模型并行执行入口
    ///
    /// ## 执行流程
    /// 1. 创建用户消息和助手消息
    /// 2. 执行共享检索 → SharedContext
    /// 3. 持久化 shared_context
    /// 4. 为每个模型创建 VariantExecutionContext
    /// 5. 发射 stream_start
    /// 6. tokio::spawn + join_all 并行执行所有变体
    /// 7. 收集变体结果，确定 active_variant_id（第一个成功的）
    /// 8. 持久化变体列表
    /// 9. 发射 stream_complete
    ///
    /// ## 约束
    /// - 检索只执行一次
    /// - 多变体模式下强制 anki_enabled = false
    /// - 超过 max_variants_per_message 返回 LimitExceeded 错误
    /// - active_variant_id 默认设为第一个成功的变体
    ///
    /// ## 参数
    /// - `window`: Tauri 窗口句柄
    /// - `request`: 发送消息请求
    /// - `model_ids`: 要并行执行的模型 ID 列表
    /// - `cancel_token`: 取消令牌
    ///
    /// ## 返回
    /// 助手消息 ID
    /// 🔧 P1修复：添加 chat_v2_state 参数，用于注册每个变体的 cancel token
    pub async fn execute_multi_variant(
        &self,
        window: tauri::Window,
        request: SendMessageRequest,
        model_ids: Vec<String>,
        cancel_token: CancellationToken,
        chat_v2_state: Option<Arc<super::super::state::ChatV2State>>,
    ) -> ChatV2Result<String> {
        use super::super::variant_context::{ParallelExecutionManager, VariantExecutionContext};
        use futures::future::join_all;

        let start_time = Instant::now();
        let session_id = request.session_id.clone();
        let user_content = request.content.clone();
        let mut options = request.options.clone().unwrap_or_default();

        // === 0. 智能 vision_quality 计算（与单变体路径保持一致）===
        // 如果用户没有显式指定，根据图片数量和来源自动选择压缩策略
        if options
            .vision_quality
            .as_deref()
            .filter(|v| !v.is_empty() && *v != "auto")
            .is_none()
        {
            let user_refs = request.user_context_refs.as_deref().unwrap_or(&[]);
            let mut image_count = 0usize;
            let mut has_pdf_or_textbook = false;

            for ctx_ref in user_refs {
                // 统计图片块数量
                for block in &ctx_ref.formatted_blocks {
                    if matches!(block, super::super::resource_types::ContentBlock::Image { .. }) {
                        image_count += 1;
                    }
                }
                // 检查是否有 PDF/教材来源
                let type_id_lower = ctx_ref.type_id.to_lowercase();
                if type_id_lower.contains("pdf")
                    || type_id_lower.contains("textbook")
                    || type_id_lower.contains("file")
                    || ctx_ref.resource_id.starts_with("tb_")
                {
                    has_pdf_or_textbook = true;
                }
            }

            // 智能策略
            let auto_quality = if has_pdf_or_textbook || image_count >= 6 {
                "low" // PDF/教材 或大量图片：最大压缩
            } else if image_count >= 2 {
                "medium" // 中等数量：平衡压缩
            } else {
                "high" // 单图或无图：保持原质量
            };

            log::info!(
                "[ChatV2::pipeline] Multi-variant vision_quality: auto -> '{}' (images={}, has_pdf_or_textbook={})",
                auto_quality, image_count, has_pdf_or_textbook
            );
            options.vision_quality = Some(auto_quality.to_string());
        }

        // === 1. 约束检查 ===
        // 检查变体数量限制
        let max_variants = options
            .max_variants_per_message
            .unwrap_or(Self::DEFAULT_MAX_VARIANTS);
        if model_ids.len() as u32 > max_variants {
            return Err(ChatV2Error::LimitExceeded(format!(
                "Variant count {} exceeds maximum allowed {}",
                model_ids.len(),
                max_variants
            )));
        }

        if model_ids.is_empty() {
            return Err(ChatV2Error::Other("No model IDs provided".to_string()));
        }

        // 🔧 2025-01-27 对齐单变体：多变体模式现在支持 Anki，使用用户配置的值
        // options.anki_enabled 保持用户配置，不再强制禁用

        // === 获取 API 配置，构建 config_id -> model 的映射 ===
        // 前端传递的是 API 配置 ID，我们需要从中提取真正的模型名称用于前端显示
        let api_configs = self
            .llm_manager
            .get_api_configs()
            .await
            .map_err(|e| ChatV2Error::Other(format!("Failed to get API configs: {}", e)))?;

        // 构建 config_id -> (model, config_id) 的映射
        // model: 用于前端显示（如 "Qwen/Qwen3-8B"）
        // config_id: 用于 LLM 调用
        let config_map: std::collections::HashMap<String, (String, String)> = api_configs
            .into_iter()
            .map(|c| (c.id.clone(), (c.model.clone(), c.id)))
            .collect();

        // 解析 model_ids，提取真正的模型名称和配置 ID
        let resolved_models: Vec<(String, String)> = model_ids
            .iter()
            .filter_map(|config_id| {
                config_map.get(config_id).cloned().or_else(|| {
                    // 🔧 三轮修复：如果 config_id 是配置 UUID，不应作为模型显示名称
                    if is_config_id_format(config_id) {
                        log::warn!(
                            "[ChatV2::pipeline] Config not found for id and id is a config format, using empty display name: {}",
                            config_id
                        );
                        Some((String::new(), config_id.clone()))
                    } else {
                        log::warn!(
                            "[ChatV2::pipeline] Config not found for id: {}, using as model name",
                            config_id
                        );
                        Some((config_id.clone(), config_id.clone()))
                    }
                })
            })
            .collect();

        log::info!(
            "[ChatV2::pipeline] execute_multi_variant: session={}, models={:?}, content_len={}",
            session_id,
            resolved_models.iter().map(|(m, _)| m).collect::<Vec<_>>(),
            user_content.len()
        );

        // === 2. 使用请求中的消息 ID（如果提供），否则生成新的 ===
        // 🔧 修复：使用前端传递的 ID，确保前后端一致
        let user_message_id = request
            .user_message_id
            .clone()
            .unwrap_or_else(ChatMessage::generate_id);
        let assistant_message_id = request
            .assistant_message_id
            .clone()
            .unwrap_or_else(ChatMessage::generate_id);

        // === 3. 创建事件发射器 ===
        let emitter = Arc::new(ChatV2EventEmitter::new(window.clone(), session_id.clone()));

        // === 4. 执行共享检索（只执行一次）===
        let shared_context = self
            .execute_shared_retrievals(&request, &emitter, &assistant_message_id)
            .await?;
        let shared_context = Arc::new(shared_context);

        log::debug!(
            "[ChatV2::pipeline] Shared retrievals completed: has_sources={}",
            shared_context.has_sources()
        );

        // === 5. 发射 stream_start ===
        // 多变体模式不在 stream_start 中传递模型名称，每个变体通过 variant_start 事件传递
        emitter.emit_stream_start(&assistant_message_id, None);

        // 🆕 P0防闪退：用户消息即时保存（多变体模式）
        // 在变体执行前立即保存用户消息，确保用户输入不会因闪退丢失
        if !options.skip_user_message_save.unwrap_or(false) {
            // 构建临时 PipelineContext 用于保存用户消息
            let temp_request = SendMessageRequest {
                session_id: session_id.clone(),
                content: user_content.clone(),
                user_message_id: Some(user_message_id.clone()),
                assistant_message_id: Some(assistant_message_id.clone()),
                options: Some(options.clone()),
                user_context_refs: request.user_context_refs.clone(),
                path_map: request.path_map.clone(),
                workspace_id: request.workspace_id.clone(),
            };
            let temp_ctx = PipelineContext::new(temp_request);
            if let Err(e) = self.save_user_message_immediately(&temp_ctx).await {
                log::warn!(
                    "[ChatV2::pipeline] Multi-variant: Failed to save user message immediately: {}",
                    e
                );
            } else {
                log::info!(
                    "[ChatV2::pipeline] Multi-variant: User message saved immediately: id={}",
                    user_message_id
                );
            }
        }

        // === 6. 创建并行执行管理器 ===
        let manager = ParallelExecutionManager::with_cancel_token(cancel_token.clone());

        // 为每个模型创建 VariantExecutionContext
        // 使用 resolved_models 中的 (模型名称, 配置ID) 元组
        // - 模型名称：传递给变体上下文，用于前端显示
        // - 配置ID：用于 LLM 调用
        let mut variant_contexts: Vec<(Arc<VariantExecutionContext>, String)> =
            Vec::with_capacity(resolved_models.len());
        for (model_name, config_id) in &resolved_models {
            let variant_id = Variant::generate_id();
            let ctx = manager.create_variant(
                variant_id.clone(),
                model_name.clone(), // 使用模型名称，用于前端显示
                assistant_message_id.clone(),
                Arc::clone(&shared_context),
                Arc::clone(&emitter),
            );

            // 🔧 P2修复：设置 config_id，用于重试时正确选择模型
            ctx.set_config_id(config_id.clone());

            // 🔧 P1修复：为每个变体注册独立的 cancel token
            // 使用 session_id:variant_id 作为 key，这样可以精确取消单个变体
            if let Some(ref state) = chat_v2_state {
                let cancel_key = format!("{}:{}", session_id, variant_id);
                state.register_existing_token(&cancel_key, ctx.cancel_token().clone());
                log::debug!(
                    "[ChatV2::pipeline] Registered cancel token for variant: {}",
                    cancel_key
                );
            }

            variant_contexts.push((ctx, config_id.clone())); // 保存配置ID用于LLM调用
        }

        // === 6.5 防闪退：持久化助手消息骨架（含 pending 变体列表）===
        // 在变体执行前写入 DB，确保刷新/崩溃后仍能识别为多变体消息。
        // save_multi_variant_results 使用 INSERT OR REPLACE 在完成后覆盖此骨架。
        {
            let skeleton_variants: Vec<Variant> = variant_contexts
                .iter()
                .map(|(ctx, _)| {
                    Variant::new_with_id_and_config(
                        ctx.variant_id().to_string(),
                        ctx.model_id().to_string(),
                        ctx.get_config_id().unwrap_or_default(),
                    )
                })
                .collect();

            let first_variant_id = skeleton_variants.first().map(|v| v.id.clone());

            let skeleton_msg = ChatMessage {
                id: assistant_message_id.clone(),
                session_id: session_id.clone(),
                role: MessageRole::Assistant,
                block_ids: Vec::new(),
                timestamp: chrono::Utc::now().timestamp_millis(),
                persistent_stable_id: None,
                parent_id: None,
                supersedes: None,
                meta: Some(MessageMeta {
                    model_id: None,
                    chat_params: Some(serde_json::json!({
                        "multiVariantMode": true,
                    })),
                    sources: None,
                    tool_results: None,
                    anki_cards: None,
                    usage: None,
                    context_snapshot: None,
                }),
                attachments: None,
                active_variant_id: first_variant_id,
                variants: Some(skeleton_variants),
                shared_context: Some((*shared_context).clone()),
            };

            if let Ok(conn) = self.db.get_conn_safe() {
                if let Err(e) = ChatV2Repo::create_message_with_conn(&conn, &skeleton_msg) {
                    log::warn!(
                        "[ChatV2::pipeline] Failed to persist skeleton assistant message (non-fatal): {}",
                        e
                    );
                } else {
                    log::info!(
                        "[ChatV2::pipeline] Persisted skeleton assistant message: id={}, variants={}",
                        assistant_message_id,
                        variant_contexts.len()
                    );
                }
            }
        }

        // === 7. 并行执行所有变体 ===
        let self_clone = self.clone();
        let options_arc = Arc::new(options.clone());
        let user_content_arc = Arc::new(user_content.clone());
        let session_id_arc = Arc::new(session_id.clone());

        // 🔧 P1修复：使用任务追踪器追踪并行任务
        // 创建并行任务
        let futures: Vec<_> = variant_contexts.iter().map(|(ctx, config_id)| {
            let self_ref = self_clone.clone();
            let ctx_clone = Arc::clone(ctx);
            let config_id_clone = config_id.clone();  // API 配置 ID，用于 LLM 调用
            let options_clone = Arc::clone(&options_arc);
            let user_content_clone = Arc::clone(&user_content_arc);
            let session_id_clone = Arc::clone(&session_id_arc);
            let shared_ctx = Arc::clone(&shared_context);
            // ★ 2025-12-10 统一改造：附件不再通过 request.attachments 传递
            let attachments = Vec::new();
            let state_clone = chat_v2_state.clone();

            let future = async move {
                self_ref.execute_single_variant_with_config(
                    ctx_clone,
                    config_id_clone,  // 传递 API 配置 ID
                    (*options_clone).clone(),
                    (*user_content_clone).clone(),
                    (*session_id_clone).clone(),
                    shared_ctx,
                    attachments,
                ).await
            };

            // 🔧 P1修复：优先使用 spawn_tracked 追踪任务
            if let Some(ref state) = state_clone {
                state.spawn_tracked(future)
            } else {
                log::warn!("[ChatV2::pipeline] spawn_tracked unavailable, using untracked tokio::spawn for variant task");
                tokio::spawn(future)
            }
        }).collect();

        // 等待所有变体完成
        let results = join_all(futures).await;

        // 处理结果
        for (i, result) in results.into_iter().enumerate() {
            let (ctx, _) = &variant_contexts[i];
            match result {
                Ok(Ok(())) => {
                    log::info!(
                        "[ChatV2::pipeline] Variant {} completed successfully",
                        ctx.variant_id()
                    );
                }
                Ok(Err(e)) => {
                    log::error!(
                        "[ChatV2::pipeline] Variant {} failed: {}",
                        ctx.variant_id(),
                        e
                    );
                    // 错误已经在 execute_single_variant_with_config 中处理
                }
                Err(e) => {
                    log::error!(
                        "[ChatV2::pipeline] Variant {} task panicked: {}",
                        ctx.variant_id(),
                        e
                    );
                    // 标记为错误
                    ctx.fail(&format!("Task panicked: {}", e));
                }
            }
        }

        // === 8. 确定 active_variant_id ===
        let active_variant_id = manager.get_first_success();

        log::info!(
            "[ChatV2::pipeline] Multi-variant execution completed: active_variant={:?}, success={}, error={}",
            active_variant_id,
            manager.success_count(),
            manager.error_count()
        );

        // === 9. 构建上下文快照（统一上下文注入系统） ===
        let context_snapshot = {
            let mut snapshot = ContextSnapshot::new();

            // 9.1 添加用户上下文引用
            if let Some(ref user_refs) = request.user_context_refs {
                for send_ref in user_refs {
                    snapshot.add_user_ref(send_ref.to_context_ref());
                }
            }

            // 9.2 为检索结果创建资源（如果有）
            // 注：多变体模式下检索结果存储在 shared_context 中
            // 这里我们将检索结果转换为 retrieval 类型的资源
            // TODO: 如果需要更精细的检索资源管理，可以在 execute_shared_retrievals 中直接创建资源

            if snapshot.has_refs() {
                log::debug!(
                    "[ChatV2::pipeline] Multi-variant context snapshot: user_refs={}, retrieval_refs={}",
                    snapshot.user_refs.len(),
                    snapshot.retrieval_refs.len()
                );
                Some(snapshot)
            } else {
                None
            }
        };

        // === 10. 持久化消息和变体 ===
        // 提取纯变体上下文列表用于保存
        let contexts_only: Vec<Arc<VariantExecutionContext>> = variant_contexts
            .iter()
            .map(|(ctx, _)| Arc::clone(ctx))
            .collect();
        // ★ 2025-12-10 统一改造：附件不再通过 request.attachments 传递
        let empty_attachments: Vec<crate::chat_v2::types::AttachmentInput> = Vec::new();
        let save_result = self.save_multi_variant_results(
            &session_id,
            &user_message_id,
            &assistant_message_id,
            &user_content,
            &empty_attachments,
            &options,
            &shared_context,
            &contexts_only,
            active_variant_id.as_deref(),
            context_snapshot,
        )
        .await;

        // === 11. 清理每个变体的 cancel token（无论保存成败都必须执行）===
        if let Some(ref state) = chat_v2_state {
            for (ctx, _) in &variant_contexts {
                let cancel_key = format!("{}:{}", session_id, ctx.variant_id());
                state.remove_stream(&cancel_key);
            }
            log::debug!(
                "[ChatV2::pipeline] Cleaned up {} variant cancel tokens",
                variant_contexts.len()
            );
        }

        save_result?;

        // === 12. 发射 stream_complete（带 token 统计） ===
        let duration_ms = start_time.elapsed().as_millis() as u64;
        // 多变体模式下 Message._meta.usage 为 None，每个变体独立统计
        // TODO: Prompt 9 实现后，可选择性汇总所有变体的 token 统计
        emitter.emit_stream_complete_with_usage(&assistant_message_id, duration_ms, None);

        log::info!(
            "[ChatV2::pipeline] Multi-variant pipeline completed in {}ms",
            duration_ms
        );

        // 🔧 自动生成会话摘要（多变体模式）
        // 使用 active_variant 的内容来生成摘要
        if let Some(active_id) = &active_variant_id {
            if let Some((active_ctx, _)) = variant_contexts
                .iter()
                .find(|(ctx, _)| ctx.variant_id() == active_id.as_str())
            {
                let assistant_content = active_ctx.get_accumulated_content();
                if self
                    .should_generate_summary(&session_id, &user_content, &assistant_content)
                    .await
                {
                    let pipeline = self.clone();
                    let sid = session_id.clone();
                    let emitter_clone = emitter.clone();
                    let user_content_clone = user_content.clone();

                    // 🆕 P1修复：使用 TaskTracker 追踪异步任务
                    let summary_future = async move {
                        pipeline
                            .generate_summary(
                                &sid,
                                &user_content_clone,
                                &assistant_content,
                                emitter_clone,
                            )
                            .await;
                    };

                    // 🔧 P1修复：优先使用 spawn_tracked 追踪摘要任务
                    if let Some(ref state) = chat_v2_state {
                        state.spawn_tracked(summary_future);
                    } else {
                        log::warn!("[ChatV2::pipeline] spawn_tracked unavailable, using untracked tokio::spawn for summary task (multi-variant)");
                        tokio::spawn(summary_future);
                    }
                }
            }
        }

        Ok(assistant_message_id)
    }

    /// 执行单个变体
    ///
    /// 在隔离的上下文中执行 LLM 调用，支持工具递归。
    ///
    /// ## 参数
    /// - `ctx`: 变体执行上下文
    /// - `options`: 发送选项
    /// - `user_content`: 用户消息内容
    /// - `session_id`: 会话 ID
    /// - `shared_context`: 共享上下文（检索结果）
    /// - `attachments`: 附件列表
    async fn execute_single_variant(
        &self,
        ctx: Arc<super::super::variant_context::VariantExecutionContext>,
        mut options: SendOptions,
        user_content: String,
        session_id: String,
        shared_context: Arc<SharedContext>,
        attachments: Vec<AttachmentInput>,
    ) -> ChatV2Result<()> {
        // 使用变体的模型 ID
        options.model_id = Some(ctx.model_id().to_string());
        options.model2_override_id = Some(ctx.model_id().to_string());

        // 开始流式生成
        ctx.start_streaming();

        // 检查是否已取消
        if ctx.is_cancelled() {
            ctx.cancel();
            return Ok(());
        }

        // 构建系统提示（包含共享的检索结果）
        let system_prompt = self
            .build_system_prompt_with_shared_context(&options, &shared_context)
            .await;

        // 加载聊天历史
        let mut chat_history = self.load_variant_chat_history(&session_id).await?;
        // 🆕 2026-02-22: 为已激活的默认技能自动注入合成 load_skills 工具交互
        inject_synthetic_load_skills(&mut chat_history, &options);

        // 构建当前用户消息
        let current_user_message = self.build_variant_user_message(&user_content, &attachments);

        // 创建 LLM 适配器（使用变体的事件发射）
        let enable_thinking = options.enable_thinking.unwrap_or(true);
        let emitter = Arc::new(VariantLLMAdapter::new(Arc::clone(&ctx), enable_thinking));

        // 注册 LLM 流式回调 hooks
        // 🔧 P0修复：每个变体使用唯一的 hook 键，避免并行执行时互相覆盖
        // 前端仍然监听 chat_v2_event_{session_id}，变体 ID 通过 VariantLLMAdapter 在事件 payload 中携带
        let stream_event = format!("chat_v2_event_{}_{}", session_id, ctx.variant_id());
        self.llm_manager
            .register_stream_hooks(&stream_event, emitter.clone())
            .await;

        // 构建消息历史
        let mut messages = chat_history;
        messages.push(current_user_message);

        // 构建 LLM 上下文
        let mut llm_context: std::collections::HashMap<String, Value> =
            std::collections::HashMap::new();
        if let Some(ref rag_sources) = shared_context.rag_sources {
            llm_context.insert(
                "prefetched_rag_sources".into(),
                serde_json::to_value(rag_sources).unwrap_or(Value::Null),
            );
        }
        if let Some(ref memory_sources) = shared_context.memory_sources {
            llm_context.insert(
                "prefetched_memory_sources".into(),
                serde_json::to_value(memory_sources).unwrap_or(Value::Null),
            );
        }
        if let Some(ref graph_sources) = shared_context.graph_sources {
            llm_context.insert(
                "prefetched_graph_sources".into(),
                serde_json::to_value(graph_sources).unwrap_or(Value::Null),
            );
        }
        if let Some(ref web_sources) = shared_context.web_search_sources {
            llm_context.insert(
                "prefetched_web_search_sources".into(),
                serde_json::to_value(web_sources).unwrap_or(Value::Null),
            );
        }

        // 🆕 图片压缩策略：从 options 获取或使用默认值
        // 如果 options.vision_quality 未设置，默认使用 "auto" 让 file_manager 根据图片大小自动选择
        let vq = options.vision_quality.as_deref().unwrap_or("auto");
        llm_context.insert("vision_quality".into(), Value::String(vq.to_string()));

        // 🔧 P1修复：将 context_limit 作为 max_input_tokens_override 传递给 LLM
        let max_input_tokens_override = options.context_limit.map(|v| v as usize);

        // 🔧 2025-01-27 对齐单变体：多变体模式现在支持工具链，使用 options 中的配置
        // 检查是否有工具可用（与 execute_single_variant_with_config 保持一致）
        let has_tools = options
            .mcp_tool_schemas
            .as_ref()
            .map(|s| !s.is_empty())
            .unwrap_or(false);
        let disable_tools = options.disable_tools.unwrap_or(false) || !has_tools;

        // 🔧 2025-01-27 对齐单变体：注入工具 schemas 到 LLM 上下文
        // 注意：execute_single_variant 用于单次变体重试，不支持工具递归调用
        // 如需完整的工具调用循环，请使用 execute_single_variant_with_config
        if !disable_tools {
            if let Some(ref tool_schemas) = options.mcp_tool_schemas {
                let mcp_tool_values: Vec<Value> = tool_schemas
                    .iter()
                    .map(|tool| {
                        let raw_tool_name = if tool.name.starts_with(BUILTIN_NAMESPACE) {
                            tool.name.clone()
                        } else {
                            format!("mcp_{}", tool.name)
                        };
                        let api_tool_name = sanitize_tool_name_for_api(&raw_tool_name);
                        json!({
                            "type": "function",
                            "function": {
                                "name": api_tool_name,
                                "description": tool.description.clone().unwrap_or_default(),
                                "parameters": tool.input_schema.clone().unwrap_or(json!({}))
                            }
                        })
                    })
                    .collect();

                if !mcp_tool_values.is_empty() {
                    llm_context.insert("tools".into(), Value::Array(mcp_tool_values.clone()));
                    log::info!(
                        "[ChatV2::VariantPipeline] execute_single_variant: variant={} injected {} tools",
                        ctx.variant_id(),
                        mcp_tool_values.len()
                    );
                }
            }
        }

        // 调用 LLM
        // 🔧 P1修复：添加 Pipeline 层超时保护
        let llm_future = self.llm_manager.call_unified_model_2_stream(
            &llm_context,
            &messages,
            "",
            true,
            enable_thinking,
            Some("chat_v2_variant"),
            ctx.emitter().window(),
            &stream_event,
            None,
            disable_tools,
            max_input_tokens_override,
            options.model_id.clone(),
            options.temperature,
            Some(system_prompt),
            options.top_p,
            options.frequency_penalty,
            options.presence_penalty,
            options.max_tokens,
        );

        let call_result =
            match timeout(Duration::from_secs(LLM_STREAM_TIMEOUT_SECS), llm_future).await {
                Ok(result) => result,
                Err(_) => {
                    log::error!(
                        "[ChatV2::VariantPipeline] LLM stream call timeout after {}s, variant={}",
                        LLM_STREAM_TIMEOUT_SECS,
                        ctx.variant_id()
                    );
                    self.llm_manager
                        .unregister_stream_hooks(&stream_event)
                        .await;
                    ctx.fail(&format!(
                        "LLM stream call timed out after {}s",
                        LLM_STREAM_TIMEOUT_SECS
                    ));
                    return Err(ChatV2Error::Timeout(format!(
                        "LLM stream call timed out after {}s",
                        LLM_STREAM_TIMEOUT_SECS
                    )));
                }
            };

        // 注销 hooks
        self.llm_manager
            .unregister_stream_hooks(&stream_event)
            .await;

        // 处理结果
        match call_result {
            Ok(output) => {
                if output.cancelled {
                    ctx.cancel();
                } else {
                    ctx.complete();
                }
                Ok(())
            }
            Err(e) => {
                ctx.fail(&e.to_string());
                Err(ChatV2Error::Llm(e.to_string()))
            }
        }
    }

    async fn execute_single_variant_with_config(
        &self,
        ctx: Arc<super::super::variant_context::VariantExecutionContext>,
        config_id: String,
        mut options: SendOptions,
        user_content: String,
        session_id: String,
        shared_context: Arc<SharedContext>,
        attachments: Vec<AttachmentInput>,
    ) -> ChatV2Result<()> {
        const MAX_TOOL_ROUNDS: u32 = 10;

        options.model_id = Some(config_id.clone());
        options.model2_override_id = Some(config_id.clone());

        ctx.start_streaming();

        if ctx.is_cancelled() {
            ctx.cancel();
            return Ok(());
        }

        let system_prompt = self
            .build_system_prompt_with_shared_context(&options, &shared_context)
            .await;
        let mut chat_history = self.load_variant_chat_history(&session_id).await?;
        // 🆕 2026-02-22: 为已激活的默认技能自动注入合成 load_skills 工具交互
        inject_synthetic_load_skills(&mut chat_history, &options);
        let current_user_message = self.build_variant_user_message(&user_content, &attachments);

        let enable_thinking = options.enable_thinking.unwrap_or(true);
        let max_input_tokens_override = options.context_limit.map(|v| v as usize);
        let has_tools = options
            .mcp_tool_schemas
            .as_ref()
            .map(|s| !s.is_empty())
            .unwrap_or(false);
        let disable_tools = options.disable_tools.unwrap_or(false) || !has_tools;

        let mut messages = chat_history;
        messages.push(current_user_message);

        let adapter = Arc::new(VariantLLMAdapter::new(Arc::clone(&ctx), enable_thinking));
        let stream_event = format!("chat_v2_event_{}_{}", session_id, ctx.variant_id());
        self.llm_manager
            .register_stream_hooks(&stream_event, adapter.clone())
            .await;

        let mut llm_context: std::collections::HashMap<String, Value> =
            std::collections::HashMap::new();
        if let Some(ref rag_sources) = shared_context.rag_sources {
            llm_context.insert(
                "prefetched_rag_sources".into(),
                serde_json::to_value(rag_sources).unwrap_or(Value::Null),
            );
        }
        if let Some(ref memory_sources) = shared_context.memory_sources {
            llm_context.insert(
                "prefetched_memory_sources".into(),
                serde_json::to_value(memory_sources).unwrap_or(Value::Null),
            );
        }
        if let Some(ref graph_sources) = shared_context.graph_sources {
            llm_context.insert(
                "prefetched_graph_sources".into(),
                serde_json::to_value(graph_sources).unwrap_or(Value::Null),
            );
        }
        if let Some(ref web_sources) = shared_context.web_search_sources {
            llm_context.insert(
                "prefetched_web_search_sources".into(),
                serde_json::to_value(web_sources).unwrap_or(Value::Null),
            );
        }

        // 🆕 图片压缩策略：从 options 获取或使用默认值
        let vq = options.vision_quality.as_deref().unwrap_or("auto");
        llm_context.insert("vision_quality".into(), Value::String(vq.to_string()));

        // 🔧 工具名称映射：sanitized API name → original name
        let mut variant_tool_name_mapping: HashMap<String, String> = HashMap::new();

        if !disable_tools {
            if let Some(ref tool_schemas) = options.mcp_tool_schemas {
                let mcp_tool_values: Vec<Value> = tool_schemas
                    .iter()
                    .map(|tool| {
                        let raw_tool_name = if tool.name.starts_with(BUILTIN_NAMESPACE) {
                            tool.name.clone()
                        } else {
                            format!("mcp_{}", tool.name)
                        };
                        let api_tool_name = sanitize_tool_name_for_api(&raw_tool_name);
                        if api_tool_name != raw_tool_name {
                            variant_tool_name_mapping.insert(api_tool_name.clone(), raw_tool_name);
                        }
                        json!({
                            "type": "function",
                            "function": {
                                "name": api_tool_name,
                                "description": tool.description.clone().unwrap_or_default(),
                                "parameters": tool.input_schema.clone().unwrap_or(json!({}))
                            }
                        })
                    })
                    .collect();

                if !mcp_tool_values.is_empty() {
                    llm_context.insert("tools".into(), Value::Array(mcp_tool_values.clone()));
                    log::info!(
                        "[ChatV2::VariantPipeline] variant={} injected {} tools",
                        ctx.variant_id(),
                        mcp_tool_values.len()
                    );
                }
            }
        }

        let emitter_arc = ctx.emitter_arc();
        let canvas_note_id = options.canvas_note_id.clone();
        // 🔧 用户可通过 disable_tool_whitelist 关闭白名单检查
        let skill_allowed_tools = if options.disable_tool_whitelist.unwrap_or(false) {
            log::info!("[ChatV2::VariantPipeline] 🔓 Tool whitelist check disabled by user setting");
            None
        } else {
            options.skill_allowed_tools.clone()
        };
        let skill_contents = options.skill_contents.clone();
        let active_skill_ids = options.active_skill_ids.clone();
        let variant_session_key = format!("{}:{}", session_id, ctx.variant_id());

        let mut tool_round = 0u32;
        loop {
            if ctx.is_cancelled() {
                ctx.cancel();
                break;
            }

            // 🔧 P1修复：添加 Pipeline 层超时保护
            let llm_future = self.llm_manager.call_unified_model_2_stream(
                &llm_context,
                &messages,
                "",
                true,
                enable_thinking,
                Some("chat_v2_variant"),
                ctx.emitter().window(),
                &stream_event,
                None,
                disable_tools,
                max_input_tokens_override,
                options.model_id.clone(),
                options.temperature,
                Some(system_prompt.clone()),
                options.top_p,
                options.frequency_penalty,
                options.presence_penalty,
                options.max_tokens,
            );

            // 使用 tokio::select! 支持取消（与单变体 pipeline 对齐）
            let call_result = tokio::select! {
                result = timeout(
                    Duration::from_secs(LLM_STREAM_TIMEOUT_SECS),
                    llm_future,
                ) => {
                    match result {
                        Ok(r) => Some(r),
                        Err(_) => {
                            log::error!(
                                "[ChatV2::VariantPipeline] LLM stream call timeout after {}s, variant={}, round={}",
                                LLM_STREAM_TIMEOUT_SECS,
                                ctx.variant_id(),
                                tool_round
                            );
                            self.llm_manager
                                .unregister_stream_hooks(&stream_event)
                                .await;
                            ctx.fail(&format!(
                                "LLM stream call timed out after {}s",
                                LLM_STREAM_TIMEOUT_SECS
                            ));
                            return Err(ChatV2Error::Timeout(format!(
                                "LLM stream call timed out after {}s",
                                LLM_STREAM_TIMEOUT_SECS
                            )));
                        }
                    }
                }
                _ = ctx.cancel_token().cancelled() => {
                    log::info!(
                        "[ChatV2::VariantPipeline] LLM call cancelled via token, variant={}, round={}",
                        ctx.variant_id(),
                        tool_round
                    );
                    // 同时通知 LLM 层停止 HTTP 流
                    self.llm_manager.request_cancel_stream(&stream_event).await;
                    None
                }
            };

            match call_result {
                None => {
                    // cancel_token 触发的取消
                    ctx.cancel();
                    break;
                }
                Some(Ok(output)) => {
                    if output.cancelled {
                        ctx.cancel();
                        break;
                    }
                }
                Some(Err(e)) => {
                    self.llm_manager
                        .unregister_stream_hooks(&stream_event)
                        .await;
                    ctx.fail(&e.to_string());
                    return Err(ChatV2Error::Llm(e.to_string()));
                }
            }

            let tool_calls = adapter.take_tool_calls();
            if tool_calls.is_empty() {
                adapter.finalize_all();
                ctx.complete();
                break;
            }

            log::info!(
                "[ChatV2::VariantPipeline] variant={} round={} has {} tool calls",
                ctx.variant_id(),
                tool_round,
                tool_calls.len()
            );

            let current_reasoning = adapter.get_accumulated_reasoning();
            adapter.finalize_all();
            ctx.set_pending_reasoning(current_reasoning.clone());

            // 🆕 取消支持：传递取消令牌给工具执行器
            let cancel_token = Some(ctx.cancel_token());
            let rag_top_k = options.rag_top_k;
            let rag_enable_reranking = options.rag_enable_reranking;
            let tool_results = self
                .execute_tool_calls(
                    &tool_calls,
                    &emitter_arc,
                    &variant_session_key,
                    ctx.message_id(),
                    &canvas_note_id,
                    &skill_allowed_tools,
                    &skill_contents,
                    &active_skill_ids,
                    cancel_token,
                    rag_top_k,
                    rag_enable_reranking,
                    &variant_tool_name_mapping,
                )
                .await?;

            let success_count = tool_results.iter().filter(|r| r.success).count();
            log::info!(
                "[ChatV2::VariantPipeline] variant={} tool execution: {}/{} succeeded",
                ctx.variant_id(),
                success_count,
                tool_results.len()
            );

            for tc in &tool_calls {
                let tool_call = crate::models::ToolCall {
                    id: tc.id.clone(),
                    tool_name: tc.name.clone(),
                    args_json: tc.arguments.clone(),
                };
                messages.push(LegacyChatMessage {
                    role: "assistant".to_string(),
                    content: String::new(),
                    timestamp: chrono::Utc::now(),
                    thinking_content: current_reasoning.clone(),
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
                });
            }

            for result in &tool_results {
                let result_content = if result.success {
                    serde_json::to_string(&result.output).unwrap_or_else(|_| "{}".to_string())
                } else {
                    format!(
                        "Error: {}",
                        result.error.as_deref().unwrap_or("Unknown error")
                    )
                };

                let tool_result = crate::models::ToolResult {
                    call_id: result.tool_call_id.clone().unwrap_or_default(),
                    ok: result.success,
                    error: result.error.clone(),
                    error_details: None,
                    data_json: Some(result.output.clone()),
                    usage: None,
                    citations: None,
                };
                messages.push(LegacyChatMessage {
                    role: "tool".to_string(),
                    content: result_content,
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
                });

                ctx.add_tool_result(result.clone());
            }

            let task_completed = tool_results.iter().any(|r| {
                r.output
                    .get("task_completed")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
            });
            if task_completed {
                log::info!(
                    "[ChatV2::VariantPipeline] variant={} task_completed detected, stopping",
                    ctx.variant_id()
                );
                ctx.complete();
                break;
            }

            tool_round += 1;
            ctx.increment_tool_round();

            if tool_round >= MAX_TOOL_ROUNDS {
                log::warn!(
                    "[ChatV2::VariantPipeline] variant={} reached max tool rounds ({})",
                    ctx.variant_id(),
                    MAX_TOOL_ROUNDS
                );
                ctx.complete();
                break;
            }

            adapter.reset_for_new_round();
        }

        self.llm_manager
            .unregister_stream_hooks(&stream_event)
            .await;
        Ok(())
    }

    /// 共享检索阶段（已废弃预调用模式）
    ///
    /// 🔧 2026-01-11 重构：彻底移除预调用检索，完全采用工具化模式
    ///
    /// 原预调用模式（已废弃）：
    /// - 在多变体 LLM 调用前执行 RAG/图谱/记忆/网络搜索
    /// - 结果注入到共享的系统提示中
    ///
    /// 新工具化模式（当前）：
    /// - 检索工具作为 MCP 工具注入到 LLM
    /// - 每个变体的 LLM 根据用户问题主动决定是否调用检索工具
    /// - 多变体模式下，每个变体独立调用检索（按需）
    ///
    /// ## 参数
    /// - `request`: 发送消息请求
    /// - `_emitter`: 事件发射器（不再使用）
    /// - `_message_id`: 消息 ID（不再使用）
    ///
    /// ## 返回
    /// 空的 SharedContext（工具化模式下由 LLM 按需调用检索）
    #[allow(unused_variables)]
    async fn execute_shared_retrievals(
        &self,
        request: &SendMessageRequest,
        _emitter: &Arc<ChatV2EventEmitter>,
        _message_id: &str,
    ) -> ChatV2Result<SharedContext> {
        // 🔧 工具化模式：跳过所有预调用检索
        // 多变体模式下，每个变体的 LLM 可独立通过 tool_calls 调用内置检索工具
        log::info!(
            "[ChatV2::pipeline] Tool-based retrieval mode (multi-variant): skipping shared pre-call retrievals for session={}",
            request.session_id
        );
        Ok(SharedContext::default())
    }

    /// 构建带共享上下文的系统提示
    ///
    /// 使用 prompt_builder 模块统一格式化，用于多变体并行执行场景，
    /// 共享检索结果注入到所有变体的 system prompt 中。
    /// 如果有 Canvas 笔记，也会一并注入。
    async fn build_system_prompt_with_shared_context(
        &self,
        options: &SendOptions,
        shared_context: &SharedContext,
    ) -> String {
        // 构建 Canvas 笔记信息（如果有）
        let canvas_note = self.build_canvas_note_info_from_options(options).await;
        prompt_builder::build_system_prompt_with_shared_context(
            options,
            shared_context,
            canvas_note,
        )
    }

    /// 根据 SendOptions 构建 Canvas 笔记信息
    async fn build_canvas_note_info_from_options(
        &self,
        options: &SendOptions,
    ) -> Option<prompt_builder::CanvasNoteInfo> {
        let note_id = options.canvas_note_id.as_ref()?;
        let notes_mgr = self.notes_manager.as_ref()?;
        match notes_mgr.get_note(note_id) {
            Ok(note) => {
                let word_count = note.content_md.chars().count();
                log::info!(
                    "[ChatV2::pipeline] Canvas mode (variant): loaded note '{}' ({} chars, is_long={})",
                    note.title,
                    word_count,
                    word_count >= 3000
                );
                Some(prompt_builder::CanvasNoteInfo::new(
                    note_id.clone(),
                    note.title,
                    note.content_md,
                ))
            }
            Err(e) => {
                log::warn!(
                    "[ChatV2::pipeline] Canvas mode (variant): failed to read note {}: {}",
                    note_id,
                    e
                );
                None
            }
        }
    }

    /// 加载变体的聊天历史（V2 增强版）
    ///
    /// 对齐单变体 `load_chat_history()` 的完整能力：
    /// - 使用 DEFAULT_MAX_HISTORY_MESSAGES 限制消息数
    /// - 提取所有 content 块并拼接（不只是第一个）
    /// - 提取 thinking 块内容
    /// - 提取 mcp_tool 块的工具调用信息
    /// - 解析 context_snapshot（如果有 vfs_db 连接）
    /// - 从附件中提取图片 base64 和文档附件
    async fn load_variant_chat_history(
        &self,
        session_id: &str,
    ) -> ChatV2Result<Vec<LegacyChatMessage>> {
        log::debug!(
            "[ChatV2::pipeline] Loading variant chat history for session={}",
            session_id
        );

        let conn = self.db.get_conn_safe()?;

        // 🆕 获取 VFS 数据库连接（用于解析历史消息中的 context_snapshot）
        let vfs_conn_opt = self.vfs_db.as_ref().and_then(|vfs_db| {
            match vfs_db.get_conn_safe() {
                Ok(vfs_conn) => Some(vfs_conn),
                Err(e) => {
                    log::warn!("[ChatV2::pipeline] Failed to get vfs.db connection for variant history context_snapshot: {}", e);
                    None
                }
            }
        });
        let vfs_blobs_dir = self
            .vfs_db
            .as_ref()
            .map(|vfs_db| vfs_db.blobs_dir().to_path_buf());

        let messages = ChatV2Repo::get_session_messages_with_conn(&conn, session_id)?;

        if messages.is_empty() {
            log::debug!(
                "[ChatV2::pipeline] No variant chat history found for session={}",
                session_id
            );
            return Ok(Vec::new());
        }

        // 🔧 使用固定的消息条数限制（对齐单变体）
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
            "[ChatV2::pipeline] Loading {} variant messages (max_messages={})",
            messages_to_load.len(),
            max_messages
        );

        let mut chat_history = Vec::new();
        for message in messages_to_load {
            let blocks = ChatV2Repo::get_message_blocks_with_conn(&conn, &message.id)?;

            // 🔧 提取所有 content 类型块的内容并拼接（不只是第一个）
            let content: String = blocks
                .iter()
                .filter(|b| b.block_type == block_types::CONTENT)
                .filter_map(|b| b.content.as_ref())
                .cloned()
                .collect::<Vec<_>>()
                .join("");

            // 🆕 提取 thinking 类型块的内容（如果有）
            let thinking_content: Option<String> = {
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
            };

            // 🆕 提取 mcp_tool 类型块的工具调用信息（按 block_index 排序）
            let mut tool_blocks: Vec<_> = blocks
                .iter()
                .filter(|b| b.block_type == block_types::MCP_TOOL)
                .collect();
            tool_blocks.sort_by_key(|b| b.block_index);

            // 🆕 对于用户消息，解析 context_snapshot.user_refs 并将内容追加到 content
            let (content, vfs_image_base64) = if message.role == MessageRole::User {
                if let (Some(ref vfs_conn), Some(ref blobs_dir)) = (&vfs_conn_opt, &vfs_blobs_dir) {
                    self.resolve_history_context_snapshot_v2(
                        &content,
                        &message,
                        &**vfs_conn,
                        blobs_dir,
                    )
                } else {
                    (content, Vec::new())
                }
            } else {
                (content, Vec::new())
            };

            let role = match message.role {
                MessageRole::User => "user",
                MessageRole::Assistant => "assistant",
            };

            // 🆕 如果是 assistant 消息且有工具调用，先添加工具调用消息
            if role == "assistant" && !tool_blocks.is_empty() {
                for (idx, tool_block) in tool_blocks.iter().enumerate() {
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
                    let tool_call = crate::models::ToolCall {
                        id: tool_call_id.clone(),
                        tool_name: tool_name.clone(),
                        args_json: tool_input,
                    };
                    let assistant_tool_msg = LegacyChatMessage {
                        role: "assistant".to_string(),
                        content: String::new(),
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
                        tool_call: Some(tool_call),
                        tool_result: None,
                        overrides: None,
                        relations: None,
                        persistent_stable_id: None,
                        metadata: None,
                    };
                    chat_history.push(assistant_tool_msg);

                    // 2. 添加 tool 消息（包含 tool_result）
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
                        content: serde_json::to_string(&tool_output).unwrap_or_default(),
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
                        "[ChatV2::pipeline] Loaded variant tool call from history: tool={}, block_id={}, index={}",
                        tool_name,
                        tool_block.id,
                        idx
                    );
                }
            }

            // 跳过空内容消息（但工具调用消息已经添加）
            if content.is_empty() {
                continue;
            }

            // 🆕 从附件中提取图片 base64（仅用户消息有附件）
            // 合并旧附件图片和 VFS 图片
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

            // 追加从 VFS context_snapshot 解析的图片
            all_images.extend(vfs_image_base64);

            let image_base64: Option<Vec<String>> = if all_images.is_empty() {
                None
            } else {
                Some(all_images)
            };

            // 🆕 从附件中提取文档附件（同时支持文本和二进制文档）
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

                                            // 尝试使用 DocumentParser 解析二进制文档
                                            let parser = crate::document_parser::DocumentParser::new();
                                            match parser.extract_text_from_base64(&a.name, data_part) {
                                                Ok(text) => {
                                                    log::debug!("[ChatV2::pipeline] Extracted {} chars from variant history document: {}", text.len(), a.name);
                                                    text_content = Some(text);
                                                }
                                                Err(e) => {
                                                    log::debug!("[ChatV2::pipeline] Could not parse variant history document {}: {}", a.name, e);
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
                timestamp: chrono::Utc::now(),
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
            "[ChatV2::pipeline] Loaded {} variant messages from history for session={}",
            chat_history.len(),
            session_id
        );

        // 🆕 验证工具调用链完整性
        validate_tool_chain(&chat_history);

        Ok(chat_history)
    }

    /// 构建变体用户消息
    fn build_variant_user_message(
        &self,
        user_content: &str,
        attachments: &[AttachmentInput],
    ) -> LegacyChatMessage {
        let image_base64: Option<Vec<String>> = {
            let images: Vec<String> = attachments
                .iter()
                .filter(|a| a.mime_type.starts_with("image/"))
                .filter_map(|a| a.base64_content.clone())
                .collect();
            if images.is_empty() {
                None
            } else {
                Some(images)
            }
        };

        let doc_attachments: Option<Vec<crate::models::DocumentAttachment>> = {
            let docs: Vec<crate::models::DocumentAttachment> = attachments
                .iter()
                .filter(|a| {
                    !a.mime_type.starts_with("image/")
                        && !a.mime_type.starts_with("audio/")
                        && !a.mime_type.starts_with("video/")
                })
                .map(|a| {
                    // 🔧 P0修复：如果没有 text_content 但有 base64_content，尝试使用 DocumentParser 解析
                    let text_content = if a.text_content.is_some() {
                        a.text_content.clone()
                    } else if let Some(ref base64) = a.base64_content {
                        // 尝试使用 DocumentParser 解析二进制文档（docx/pdf 等）
                        let parser = crate::document_parser::DocumentParser::new();
                        match parser.extract_text_from_base64(&a.name, base64) {
                            Ok(text) => {
                                log::info!(
                                    "[ChatV2::pipeline] Extracted {} chars from document: {}",
                                    text.len(),
                                    a.name
                                );
                                Some(text)
                            }
                            Err(e) => {
                                log::warn!(
                                    "[ChatV2::pipeline] Failed to parse document {}: {}",
                                    a.name,
                                    e
                                );
                                None
                            }
                        }
                    } else {
                        None
                    };

                    crate::models::DocumentAttachment {
                        name: a.name.clone(),
                        mime_type: a.mime_type.clone(),
                        size_bytes: a
                            .base64_content
                            .as_ref()
                            .map(|c| (c.len() * 3) / 4)
                            .unwrap_or(0),
                        text_content,
                        base64_content: a.base64_content.clone(),
                    }
                })
                .collect();
            if docs.is_empty() {
                None
            } else {
                Some(docs)
            }
        };

        LegacyChatMessage {
            role: "user".to_string(),
            content: user_content.to_string(),
            timestamp: chrono::Utc::now(),
            thinking_content: None,
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
            persistent_stable_id: None,
            metadata: None,
        }
    }

    /// 执行批量变体重试
    ///
    /// 复用原有 SharedContext，并行执行多个变体的重试。
    /// 使用单一事件发射器以保证序列号全局递增。
    pub async fn execute_variants_retry_batch(
        &self,
        window: Window,
        session_id: String,
        message_id: String,
        variants: Vec<VariantRetrySpec>,
        user_content: String,
        user_attachments: Vec<AttachmentInput>,
        shared_context: SharedContext,
        options: SendOptions,
        cancel_token: CancellationToken,
        chat_v2_state: Option<Arc<super::super::state::ChatV2State>>,
    ) -> ChatV2Result<()> {
        use super::super::variant_context::{ParallelExecutionManager, VariantExecutionContext};
        use futures::future::join_all;

        log::info!(
            "[ChatV2::pipeline] execute_variants_retry_batch: session={}, message={}, variants={}",
            session_id,
            message_id,
            variants.len()
        );

        if variants.is_empty() {
            return Err(ChatV2Error::Validation(
                "No variant IDs provided for batch retry".to_string(),
            ));
        }

        // 单一事件发射器，确保 sequenceId 全局递增
        let emitter = Arc::new(super::super::events::ChatV2EventEmitter::new(
            window.clone(),
            session_id.clone(),
        ));

        let shared_context_arc = Arc::new(shared_context);

        // 创建并行执行管理器（多变体重试）
        let manager = ParallelExecutionManager::with_cancel_token(cancel_token.clone());

        let mut variant_contexts: Vec<(Arc<VariantExecutionContext>, String)> =
            Vec::with_capacity(variants.len());

        for spec in &variants {
            let ctx = manager.create_variant(
                spec.variant_id.clone(),
                spec.model_id.clone(),
                message_id.clone(),
                Arc::clone(&shared_context_arc),
                Arc::clone(&emitter),
            );
            ctx.set_config_id(spec.config_id.clone());

            // 注册每个变体的 cancel token（用于按 variant 取消）
            if let Some(ref state) = chat_v2_state {
                let cancel_key = format!("{}:{}", session_id, spec.variant_id);
                state.register_existing_token(&cancel_key, ctx.cancel_token().clone());
                log::debug!(
                    "[ChatV2::pipeline] Registered cancel token for retry variant: {}",
                    cancel_key
                );
            }

            variant_contexts.push((ctx, spec.config_id.clone()));
        }

        // 🔧 P1修复：并行执行所有变体（使用任务追踪器）
        let self_clone = self.clone();
        let options_arc = Arc::new(options.clone());
        let user_content_arc = Arc::new(user_content.clone());
        let session_id_arc = Arc::new(session_id.clone());
        let attachments_arc = Arc::new(user_attachments.clone());

        let futures: Vec<_> = variant_contexts
            .iter()
            .map(|(ctx, config_id)| {
                let self_ref = self_clone.clone();
                let ctx_clone = Arc::clone(ctx);
                let config_id_clone = config_id.clone();
                let options_clone = Arc::clone(&options_arc);
                let user_content_clone = Arc::clone(&user_content_arc);
                let session_id_clone = Arc::clone(&session_id_arc);
                let attachments_clone = Arc::clone(&attachments_arc);
                let shared_ctx = Arc::clone(&shared_context_arc);
                let state_clone = chat_v2_state.clone();

                let future = async move {
                    self_ref
                        .execute_single_variant_with_config(
                            ctx_clone,
                            config_id_clone,
                            (*options_clone).clone(),
                            (*user_content_clone).clone(),
                            (*session_id_clone).clone(),
                            shared_ctx,
                            (*attachments_clone).clone(),
                        )
                        .await
                };

                // 🔧 P1修复：优先使用 spawn_tracked 追踪任务
                if let Some(ref state) = state_clone {
                    state.spawn_tracked(future)
                } else {
                    log::warn!("[ChatV2::pipeline] spawn_tracked unavailable, using untracked tokio::spawn for retry variant task");
                    tokio::spawn(future)
                }
            })
            .collect();

        let results = join_all(futures).await;

        for (i, result) in results.into_iter().enumerate() {
            let (ctx, _) = &variant_contexts[i];
            match result {
                Ok(Ok(())) => {
                    log::info!(
                        "[ChatV2::pipeline] Retry variant {} completed successfully",
                        ctx.variant_id()
                    );
                }
                Ok(Err(e)) => {
                    log::error!(
                        "[ChatV2::pipeline] Retry variant {} failed: {}",
                        ctx.variant_id(),
                        e
                    );
                    // 错误已在 execute_single_variant_with_config 中处理
                }
                Err(e) => {
                    log::error!(
                        "[ChatV2::pipeline] Retry variant {} task panicked: {}",
                        ctx.variant_id(),
                        e
                    );
                    ctx.fail(&format!("Task panicked: {}", e));
                }
            }
        }

        // 持久化每个变体
        let mut update_error: Option<ChatV2Error> = None;
        for (ctx, _) in &variant_contexts {
            if let Err(e) = self.update_variant_after_retry(&message_id, ctx).await {
                log::error!(
                    "[ChatV2::pipeline] Failed to update retry variant {}: {}",
                    ctx.variant_id(),
                    e
                );
                if update_error.is_none() {
                    update_error = Some(e);
                }
            }
        }

        // 清理 cancel token
        if let Some(ref state) = chat_v2_state {
            for (ctx, _) in &variant_contexts {
                let cancel_key = format!("{}:{}", session_id, ctx.variant_id());
                state.remove_stream(&cancel_key);
            }
        }

        if let Some(err) = update_error {
            return Err(err);
        }

        Ok(())
    }

    /// 执行变体重试
    ///
    /// 重新执行指定变体的 LLM 调用，复用原有的 SharedContext（检索结果）。
    ///
    /// ## 参数
    /// - `window`: Tauri 窗口，用于事件发射
    /// - `session_id`: 会话 ID
    /// - `message_id`: 助手消息 ID
    /// - `variant_id`: 要重试的变体 ID
    /// - `model_id`: 模型 ID（可能已被 model_override 覆盖）
    /// - `user_content`: 原始用户消息内容
    /// - `user_attachments`: 原始用户附件
    /// - `shared_context`: 共享上下文（检索结果，从原消息恢复）
    /// - `options`: 发送选项
    /// - `cancel_token`: 取消令牌
    ///
    /// ## 返回
    /// 成功完成后返回 Ok(())
    pub async fn execute_variant_retry(
        &self,
        window: Window,
        session_id: String,
        message_id: String,
        variant_id: String,
        model_id: String,
        user_content: String,
        user_attachments: Vec<AttachmentInput>,
        shared_context: SharedContext,
        options: SendOptions,
        cancel_token: CancellationToken,
    ) -> ChatV2Result<()> {
        log::info!(
            "[ChatV2::pipeline] execute_variant_retry: session={}, message={}, variant={}, model={}",
            session_id,
            message_id,
            variant_id,
            model_id
        );

        // 创建事件发射器
        let emitter = Arc::new(super::super::events::ChatV2EventEmitter::new(
            window.clone(),
            session_id.clone(),
        ));

        // 创建共享上下文的 Arc
        let shared_context_arc = Arc::new(shared_context);

        // 🔧 P1-4 修复：将 config_id 解析为模型显示名称
        // model_id 可能是 API 配置 UUID（如 "builtin-siliconflow"），需要解析为显示名称（如 "Qwen/Qwen3-8B"）
        // 用于 variant_start 事件和 variant.model_id 存储，确保前端能正确显示供应商图标
        let display_model_id = match self.llm_manager.get_api_configs().await {
            Ok(configs) => {
                configs
                    .iter()
                    .find(|c| c.id == model_id)
                    .map(|c| c.model.clone())
                    .or_else(|| {
                        // 通过 model 名称匹配（config_id 本身可能就是模型名）
                        configs.iter().find(|c| c.model == model_id).map(|c| c.model.clone())
                    })
                    .unwrap_or_else(|| {
                        // 无法从 configs 解析时，判断是否为配置 ID 格式
                        if is_config_id_format(&model_id) {
                            log::warn!(
                                "[ChatV2::pipeline] variant retry: config_id is not a display name: {}",
                                model_id
                            );
                            // 回退到空字符串，前端会显示 generic 图标
                            // 优于显示无法识别的 UUID
                            String::new()
                        } else {
                            model_id.clone()
                        }
                    })
            }
            Err(_) => model_id.clone(),
        };

        // 创建并行执行管理器（单变体）
        let manager = super::super::variant_context::ParallelExecutionManager::with_cancel_token(
            cancel_token.clone(),
        );

        // 创建变体执行上下文（使用已有的 variant_id）
        // 使用 display_model_id 作为变体的模型标识（用于前端图标显示）
        let ctx = manager.create_variant(
            variant_id.clone(),
            display_model_id,
            message_id.clone(),
            Arc::clone(&shared_context_arc),
            Arc::clone(&emitter),
        );

        // 执行变体（使用完整工具循环路径，与多变体主流程保持一致）
        // 注意：model_id（原始 config_id）传递给 execute_single_variant_with_config 用于 LLM 调用
        let result = self
            .execute_single_variant_with_config(
                ctx.clone(),
                model_id.clone(),
                options,
                user_content,
                session_id.clone(),
                shared_context_arc,
                user_attachments,
            )
            .await;

        // 处理结果并更新变体状态
        // 🔧 P0修复：无论成功还是失败，都需要持久化变体状态
        match result {
            Ok(()) => {
                // 更新变体在数据库中的状态和内容
                self.update_variant_after_retry(&message_id, &ctx).await?;
                log::info!(
                    "[ChatV2::pipeline] Variant retry completed: variant={}, status={}",
                    variant_id,
                    ctx.status()
                );
                Ok(())
            }
            Err(e) => {
                log::error!(
                    "[ChatV2::pipeline] Variant retry failed: variant={}, error={}",
                    variant_id,
                    e
                );
                // 🔧 P0修复：失败时也需要更新变体状态到数据库
                // ctx.status() 在 execute_single_variant 失败时会被设置为 ERROR 或 CANCELLED
                if let Err(update_err) = self.update_variant_after_retry(&message_id, &ctx).await {
                    log::error!(
                        "[ChatV2::pipeline] Failed to update variant status after error: {}",
                        update_err
                    );
                }
                Err(e)
            }
        }
    }

    /// 更新重试后的变体
    ///
    /// 更新变体状态、块内容等到数据库
    async fn update_variant_after_retry(
        &self,
        message_id: &str,
        ctx: &Arc<super::super::variant_context::VariantExecutionContext>,
    ) -> ChatV2Result<()> {
        let conn = self.db.get_conn_safe()?;
        let now_ms = chrono::Utc::now().timestamp_millis();

        // 获取消息
        let mut message = ChatV2Repo::get_message_with_conn(&conn, message_id)?
            .ok_or_else(|| ChatV2Error::MessageNotFound(message_id.to_string()))?;

        // 更新变体状态
        if let Some(ref mut variants) = message.variants {
            if let Some(variant) = variants.iter_mut().find(|v| v.id == ctx.variant_id()) {
                variant.status = ctx.status();
                variant.error = ctx.error();
                variant.block_ids = ctx.block_ids();
                let usage = ctx.get_usage();
                variant.usage = if usage.total_tokens > 0 {
                    Some(usage)
                } else {
                    None
                };
            }
        }

        // 🔧 优化：重试成功后自动设为激活变体
        if ctx.status() == variant_status::SUCCESS {
            message.active_variant_id = Some(ctx.variant_id().to_string());
            log::info!(
                "[ChatV2::pipeline] Auto-activated successful retry variant: {}",
                ctx.variant_id()
            );
        }

        // 保存 thinking 块（如果有）
        if let Some(thinking_block_id) = ctx.get_thinking_block_id() {
            let thinking_content = ctx.get_accumulated_reasoning();
            let thinking_block = MessageBlock {
                id: thinking_block_id.clone(),
                message_id: message_id.to_string(),
                block_type: block_types::THINKING.to_string(),
                status: block_status::SUCCESS.to_string(),
                content: thinking_content,
                tool_name: None,
                tool_input: None,
                tool_output: None,
                citations: None,
                error: None,
                // 🔧 P3修复：使用 first_chunk_at 作为 started_at（真正的开始时间）
                started_at: ctx.get_thinking_first_chunk_at().or(Some(now_ms)),
                ended_at: Some(now_ms),
                // 🔧 使用 VariantContext 记录的 first_chunk_at 时间戳
                first_chunk_at: ctx.get_thinking_first_chunk_at(),
                block_index: 0,
            };
            ChatV2Repo::create_block_with_conn(&conn, &thinking_block)?;

            // 添加到消息的 block_ids
            if !message.block_ids.contains(&thinking_block_id) {
                message.block_ids.push(thinking_block_id);
            }
        }

        // 保存 content 块
        if let Some(content_block_id) = ctx.get_content_block_id() {
            let content = ctx.get_accumulated_content();
            let content_block = MessageBlock {
                id: content_block_id.clone(),
                message_id: message_id.to_string(),
                block_type: block_types::CONTENT.to_string(),
                // 🔧 P1修复：正确处理 CANCELLED 状态
                status: match ctx.status().as_str() {
                    s if s == variant_status::SUCCESS => block_status::SUCCESS.to_string(),
                    s if s == variant_status::ERROR => block_status::ERROR.to_string(),
                    s if s == variant_status::CANCELLED => block_status::SUCCESS.to_string(), // cancelled 但有内容，标记为 success
                    _ => block_status::RUNNING.to_string(),
                },
                content: if content.is_empty() {
                    None
                } else {
                    Some(content)
                },
                tool_name: None,
                tool_input: None,
                tool_output: None,
                citations: None,
                error: ctx.error(),
                // 🔧 P3修复：使用 first_chunk_at 作为 started_at（真正的开始时间）
                started_at: ctx.get_content_first_chunk_at().or(Some(now_ms)),
                ended_at: Some(now_ms),
                // 🔧 使用 VariantContext 记录的 first_chunk_at 时间戳
                first_chunk_at: ctx.get_content_first_chunk_at(),
                block_index: 1, // content 在 thinking 之后
            };
            ChatV2Repo::create_block_with_conn(&conn, &content_block)?;

            // 添加到消息的 block_ids
            if !message.block_ids.contains(&content_block_id) {
                message.block_ids.push(content_block_id);
            }
        }

        // 更新消息
        ChatV2Repo::update_message_with_conn(&conn, &message)?;

        log::debug!(
            "[ChatV2::pipeline] Updated variant after retry: variant={}, blocks={}",
            ctx.variant_id(),
            ctx.block_ids().len()
        );

        Ok(())
    }

    /// 保存多变体结果
    ///
    /// 从每个 VariantExecutionContext 获取累积的内容，创建块并保存。
    ///
    /// ## 统一上下文注入系统支持
    /// - `context_snapshot`: 上下文快照（只存 ContextRef）
    async fn save_multi_variant_results(
        &self,
        session_id: &str,
        user_message_id: &str,
        assistant_message_id: &str,
        user_content: &str,
        attachments: &[AttachmentInput],
        options: &SendOptions,
        shared_context: &SharedContext,
        variant_contexts: &[Arc<super::super::variant_context::VariantExecutionContext>],
        active_variant_id: Option<&str>,
        context_snapshot: Option<ContextSnapshot>,
    ) -> ChatV2Result<()> {
        let conn = self.db.get_conn_safe()?;
        let now_ms = chrono::Utc::now().timestamp_millis();

        // P0 修复：使用事务包裹所有写操作，确保多变体保存的原子性
        conn.execute("BEGIN IMMEDIATE", []).map_err(|e| {
            log::error!(
                "[ChatV2::pipeline] Failed to begin transaction for save_multi_variant_results: {}",
                e
            );
            ChatV2Error::Database(format!("Failed to begin transaction: {}", e))
        })?;

        let save_result = (|| -> ChatV2Result<()> {

        // === 1. 保存用户消息 ===
        let mut user_msg_params =
            UserMessageParams::new(session_id.to_string(), user_content.to_string())
                .with_id(user_message_id.to_string())
                .with_attachments(attachments.to_vec())
                .with_timestamp(now_ms);

        if let Some(snapshot) = context_snapshot.clone() {
            user_msg_params = user_msg_params.with_context_snapshot(snapshot);
        }

        let user_msg_result = build_user_message(user_msg_params);

        ChatV2Repo::create_message_with_conn(&conn, &user_msg_result.message)?;
        ChatV2Repo::create_block_with_conn(&conn, &user_msg_result.block)?;

        // === 2. 🔧 P1修复：保存检索块 ===
        let mut all_block_ids: Vec<String> = Vec::new();
        let mut pending_blocks: Vec<MessageBlock> = Vec::new();
        let mut block_index_counter = 0;

        // 2.1 保存 RAG 检索块
        if let Some(ref block_id) = shared_context.rag_block_id {
            if shared_context
                .rag_sources
                .as_ref()
                .map_or(false, |v| !v.is_empty())
            {
                let rag_block = MessageBlock {
                    id: block_id.clone(),
                    message_id: assistant_message_id.to_string(),
                    block_type: block_types::RAG.to_string(),
                    status: block_status::SUCCESS.to_string(),
                    content: None,
                    tool_name: None,
                    tool_input: None,
                    tool_output: Some(json!({ "sources": shared_context.rag_sources })),
                    citations: None,
                    error: None,
                    started_at: Some(now_ms),
                    ended_at: Some(now_ms),
                    // 🔧 检索块使用 now_ms 作为 first_chunk_at
                    first_chunk_at: Some(now_ms),
                    block_index: block_index_counter,
                };
                pending_blocks.push(rag_block);
                all_block_ids.push(block_id.clone());
                block_index_counter += 1;
            }
        }

        // 2.2 保存 Memory 检索块
        if let Some(ref block_id) = shared_context.memory_block_id {
            if shared_context
                .memory_sources
                .as_ref()
                .map_or(false, |v| !v.is_empty())
            {
                let memory_block = MessageBlock {
                    id: block_id.clone(),
                    message_id: assistant_message_id.to_string(),
                    block_type: block_types::MEMORY.to_string(),
                    status: block_status::SUCCESS.to_string(),
                    content: None,
                    tool_name: None,
                    tool_input: None,
                    tool_output: Some(json!({ "sources": shared_context.memory_sources })),
                    citations: None,
                    error: None,
                    started_at: Some(now_ms),
                    ended_at: Some(now_ms),
                    // 🔧 检索块使用 now_ms 作为 first_chunk_at
                    first_chunk_at: Some(now_ms),
                    block_index: block_index_counter,
                };
                pending_blocks.push(memory_block);
                all_block_ids.push(block_id.clone());
                block_index_counter += 1;
            }
        }

        // 2.4 保存 Web 搜索检索块
        if let Some(ref block_id) = shared_context.web_search_block_id {
            if shared_context
                .web_search_sources
                .as_ref()
                .map_or(false, |v| !v.is_empty())
            {
                let web_block = MessageBlock {
                    id: block_id.clone(),
                    message_id: assistant_message_id.to_string(),
                    block_type: block_types::WEB_SEARCH.to_string(),
                    status: block_status::SUCCESS.to_string(),
                    content: None,
                    tool_name: None,
                    tool_input: None,
                    tool_output: Some(json!({ "sources": shared_context.web_search_sources })),
                    citations: None,
                    error: None,
                    started_at: Some(now_ms),
                    ended_at: Some(now_ms),
                    // 🔧 检索块使用 now_ms 作为 first_chunk_at
                    first_chunk_at: Some(now_ms),
                    block_index: block_index_counter,
                };
                pending_blocks.push(web_block);
                all_block_ids.push(block_id.clone());
                block_index_counter += 1;
            }
        }

        log::debug!(
            "[ChatV2::pipeline] Multi-variant retrieval blocks saved: {} blocks",
            block_index_counter
        );

        // === 3. 收集所有变体块信息 ===
        let mut variants: Vec<Variant> = Vec::with_capacity(variant_contexts.len());

        for ctx in variant_contexts {
            let mut block_index = 0;

            // 保存 thinking 块（如果有）
            if let Some(thinking_block_id) = ctx.get_thinking_block_id() {
                let thinking_content = ctx.get_accumulated_reasoning();
                let thinking_block = MessageBlock {
                    id: thinking_block_id.clone(),
                    message_id: assistant_message_id.to_string(),
                    block_type: block_types::THINKING.to_string(),
                    status: block_status::SUCCESS.to_string(),
                    content: thinking_content,
                    tool_name: None,
                    tool_input: None,
                    tool_output: None,
                    citations: None,
                    error: None,
                    // 🔧 P3修复：使用 first_chunk_at 作为 started_at（真正的开始时间）
                    started_at: ctx.get_thinking_first_chunk_at().or(Some(now_ms)),
                    ended_at: Some(now_ms),
                    // 🔧 使用 VariantContext 记录的 first_chunk_at 时间戳
                    first_chunk_at: ctx.get_thinking_first_chunk_at(),
                    block_index,
                };
                pending_blocks.push(thinking_block);
                all_block_ids.push(thinking_block_id);
                block_index += 1;
            }

            // 收集 content 块
            if let Some(content_block_id) = ctx.get_content_block_id() {
                let content = ctx.get_accumulated_content();
                let content_block = MessageBlock {
                    id: content_block_id.clone(),
                    message_id: assistant_message_id.to_string(),
                    block_type: block_types::CONTENT.to_string(),
                    status: if ctx.status() == variant_status::SUCCESS {
                        block_status::SUCCESS.to_string()
                    } else if ctx.status() == variant_status::ERROR {
                        block_status::ERROR.to_string()
                    } else {
                        block_status::RUNNING.to_string()
                    },
                    content: if content.is_empty() {
                        None
                    } else {
                        Some(content)
                    },
                    tool_name: None,
                    tool_input: None,
                    tool_output: None,
                    citations: None,
                    error: ctx.error(),
                    // 🔧 P3修复：使用 first_chunk_at 作为 started_at（真正的开始时间）
                    started_at: ctx.get_content_first_chunk_at().or(Some(now_ms)),
                    ended_at: Some(now_ms),
                    // 🔧 使用 VariantContext 记录的 first_chunk_at 时间戳
                    first_chunk_at: ctx.get_content_first_chunk_at(),
                    block_index,
                };
                pending_blocks.push(content_block);
                all_block_ids.push(content_block_id);
            }

            // 创建 Variant 结构
            let variant = ctx.to_variant();
            variants.push(variant);

            log::debug!(
                "[ChatV2::pipeline] Saved blocks for variant {}: status={}",
                ctx.variant_id(),
                ctx.status()
            );
        }

        // === 4. 保存助手消息（带变体信息）===
        let assistant_message = ChatMessage {
            id: assistant_message_id.to_string(),
            session_id: session_id.to_string(),
            role: MessageRole::Assistant,
            block_ids: all_block_ids,
            timestamp: now_ms,
            persistent_stable_id: None,
            parent_id: None,
            supersedes: None,
            meta: Some(MessageMeta {
                model_id: None, // 多变体模式下不设置单一模型
                chat_params: Some(json!({
                    "temperature": options.temperature,
                    "maxTokens": options.max_tokens,
                    "enableThinking": options.enable_thinking,
                    "multiVariantMode": true,
                })),
                sources: if shared_context.has_sources() {
                    Some(MessageSources {
                        rag: shared_context.rag_sources.clone(),
                        memory: shared_context.memory_sources.clone(),
                        graph: shared_context.graph_sources.clone(),
                        web_search: shared_context.web_search_sources.clone(),
                        multimodal: shared_context.multimodal_sources.clone(),
                    })
                } else {
                    None
                },
                tool_results: None,
                anki_cards: None,
                // 多变体模式下 usage 为 None（各变体独立记录）
                usage: None,
                // 🆕 统一上下文注入系统：多变体模式支持 context_snapshot
                context_snapshot: context_snapshot.clone(),
            }),
            attachments: None,
            active_variant_id: active_variant_id.map(|s| s.to_string()),
            variants: Some(variants),
            shared_context: Some(shared_context.clone()),
        };

        ChatV2Repo::create_message_with_conn(&conn, &assistant_message)?;

        // 🆕 统一上下文注入系统：消息保存后增加资源引用计数
        // 🆕 VFS 统一存储（2025-12-07）：使用 vfs.db
        if let Some(ref snapshot) = context_snapshot {
            if snapshot.has_refs() {
                if let Some(ref vfs_db) = self.vfs_db {
                    if let Ok(vfs_conn) = vfs_db.get_conn_safe() {
                        let resource_ids = snapshot.all_resource_ids();
                        // 使用同步方法增加引用计数（使用现有连接避免死锁）
                        for resource_id in &resource_ids {
                            if let Err(e) =
                                VfsResourceRepo::increment_ref_with_conn(&vfs_conn, resource_id)
                            {
                                log::warn!(
                                    "[ChatV2::pipeline] Failed to increment ref for resource {}: {}",
                                    resource_id, e
                                );
                            }
                        }
                        log::debug!(
                            "[ChatV2::pipeline] Multi-variant: incremented refs for {} resources in vfs.db",
                            resource_ids.len()
                        );
                    } else {
                        log::warn!("[ChatV2::pipeline] Multi-variant: failed to get vfs.db connection for increment refs");
                    }
                } else {
                    log::warn!("[ChatV2::pipeline] Multi-variant: vfs_db not available, skipping increment refs");
                }
            }
        }

        // === 4. 现在可以安全地创建块了（助手消息已存在）===
        for block in pending_blocks {
            ChatV2Repo::create_block_with_conn(&conn, &block)?;
        }

        log::info!(
            "[ChatV2::pipeline] Multi-variant results saved: user_msg={}, assistant_msg={}, variants={}",
            user_message_id,
            assistant_message_id,
            variant_contexts.len()
        );

        Ok(())
        })(); // 闭包结束

        match save_result {
            Ok(()) => {
                conn.execute("COMMIT", []).map_err(|e| {
                    log::error!(
                        "[ChatV2::pipeline] Failed to commit multi-variant save: {}",
                        e
                    );
                    ChatV2Error::Database(format!("Failed to commit transaction: {}", e))
                })?;
                Ok(())
            }
            Err(e) => {
                if let Err(rollback_err) = conn.execute("ROLLBACK", []) {
                    log::error!(
                        "[ChatV2::pipeline] Failed to rollback multi-variant save: {} (original: {:?})",
                        rollback_err,
                        e
                    );
                } else {
                    log::warn!(
                        "[ChatV2::pipeline] Multi-variant save rolled back: {:?}",
                        e
                    );
                }
                Err(e)
            }
        }
    }
}
