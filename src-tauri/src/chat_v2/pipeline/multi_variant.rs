use super::*;
use crate::llm_manager::ApiConfig;

fn session_skill_state_from_snapshot(
    snapshot: &crate::chat_v2::types::SkillStateSnapshot,
) -> crate::chat_v2::types::SessionSkillState {
    crate::chat_v2::types::SessionSkillState {
        manual_pinned_skill_ids: snapshot.manual_pinned_skill_ids.clone(),
        mode_required_bundle_ids: snapshot.mode_required_bundle_ids.clone(),
        agentic_session_skill_ids: snapshot.agentic_session_skill_ids.clone(),
        branch_local_skill_ids: snapshot.branch_local_skill_ids.clone(),
        effective_allowed_external_servers: snapshot.effective_allowed_external_servers.clone(),
        version: snapshot.version,
        legacy_migrated: Some(false),
    }
}

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

fn source_user_canonical_before_assistant(
    messages: &[ChatMessage],
    assistant_message_id: &str,
) -> Option<Vec<crate::chat_v2::types::CanonicalContentPart>> {
    let assistant_index = messages
        .iter()
        .position(|message| message.id == assistant_message_id)?;
    messages[..assistant_index]
        .iter()
        .rev()
        .find(|message| message.role == MessageRole::User)
        .and_then(|message| message.meta.as_ref())
        .and_then(|meta| meta.canonical_content.clone())
}

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
                    if matches!(
                        block,
                        super::super::resource_types::ContentBlock::Image { .. }
                    ) {
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
        let config_map: std::collections::HashMap<String, ApiConfig> = api_configs
            .into_iter()
            .map(|config| (config.id.clone(), config))
            .collect();

        // 解析 model_ids，提取真正的模型名称和配置 ID
        let resolved_models: Vec<(String, String)> = model_ids
            .iter()
            .filter_map(|config_id| {
                config_map
                    .get(config_id)
                    .map(|config| (config.model.clone(), config.id.clone()))
                    .or_else(|| {
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
        let emitter = Arc::new(
            ChatV2EventEmitter::new(window.clone(), session_id.clone())
                .with_stream_generation(options.stream_generation),
        );

        // === 4. 执行共享检索（只执行一次）===
        let shared_context = self
            .execute_shared_retrievals(&request, &emitter, &assistant_message_id)
            .await?;
        let shared_context = Arc::new(shared_context);

        log::debug!(
            "[ChatV2::pipeline] Shared retrievals completed: has_sources={}",
            shared_context.has_sources()
        );

        // === 4.5. 🆕 R2-CR-R2-02 修复：多变体 fan-out 前先检查是否需要压缩 ===
        // 估算会话接近上下文上限时主动压一次；所有变体看同一压缩视图。
        // 失败 / 跳过时继续 fan-out，依赖 apply_compaction_view 读视图兜底。
        if !options
            .parallel_model_ids
            .as_deref()
            .unwrap_or(&[])
            .is_empty()
        {
            let strictest_cfg = resolved_models
                .iter()
                .filter_map(|(_, config_id)| config_map.get(config_id))
                .min_by_key(|config| {
                    super::compaction::effective_usable_tokens(Some(*config), options.context_limit)
                });
            let model_for_budget = strictest_cfg
                .map(|config| config.id.as_str())
                .or_else(|| resolved_models.first().map(|(_, id)| id.as_str()))
                .or(options.model_id.as_deref());
            if self
                .should_compact_before_multi_variant_fanout(
                    &session_id,
                    strictest_cfg,
                    options.context_limit,
                )
                .await
            {
                let exclude = vec![user_message_id.clone(), assistant_message_id.clone()];
                match self
                    .run_compaction_for_session(
                        &session_id,
                        model_for_budget,
                        "auto",
                        &exclude,
                        options.context_limit,
                        options.memory_enabled,
                        Some(&cancel_token),
                    )
                    .await
                {
                    Ok(outcome) if outcome.did_compact() => {
                        log::info!(
                            "[ChatV2::pipeline] multi-variant: compaction ran successfully for session={}",
                            session_id
                        );
                    }
                    Ok(outcome) => {
                        log::debug!(
                            "[ChatV2::pipeline] multi-variant: compaction skipped for session={}: status={} reason={:?}",
                            session_id,
                            outcome.status_code(),
                            outcome.reason_code()
                        );
                        // 🆕 自动压缩失败可见化（与单变体路径同一事件契约）
                        if outcome.is_failed() {
                            if let Some(reason) = outcome.reason_code() {
                                emitter.emit_compaction_failed(reason);
                            }
                        }
                    }
                    Err(e) => {
                        log::warn!(
                            "[ChatV2::pipeline] multi-variant: compaction failed (non-fatal): {}",
                            e
                        );
                        emitter.emit_compaction_failed(
                            super::compaction::CompactionSkipReason::InternalError.as_code(),
                        );
                    }
                }
            }
        }

        // === 5. 发射 stream_start ===
        // 多变体模式不在 stream_start 中传递模型名称，每个变体通过 variant_start 事件传递
        emitter.emit_stream_start(&assistant_message_id, None);

        // Build stable canonical refs once for the shared user message. Execution snapshots remain
        // variant-local below; this first snapshot is only the crash-safe user-message audit.
        let mut base_options = options.clone();
        if let Some((_, first_config_id)) = resolved_models.first() {
            base_options.model_id = Some(first_config_id.clone());
            base_options.model2_override_id = Some(first_config_id.clone());
        }
        let temp_request = SendMessageRequest {
            session_id: session_id.clone(),
            content: user_content.clone(),
            user_message_id: Some(user_message_id.clone()),
            assistant_message_id: Some(assistant_message_id.clone()),
            options: Some(base_options),
            user_context_refs: request.user_context_refs.clone(),
            path_map: request.path_map.clone(),
            workspace_id: request.workspace_id.clone(),
        };
        let mut temp_ctx = PipelineContext::new(temp_request);
        temp_ctx.init_context_snapshot();
        self.freeze_execution_context(&mut temp_ctx).await?;
        let canonical_content = temp_ctx.canonical_content.clone();
        // The shared user message has no single active model. Per-variant snapshots are persisted
        // on VariantMeta; attaching the first variant here would misrepresent the other variants.
        temp_ctx.execution_snapshot = None;
        let user_execution_snapshot = None;

        // 🆕 P0防闪退：用户消息即时保存（多变体模式）
        // 在变体执行前立即保存用户消息，确保用户输入不会因闪退丢失
        if !options.skip_user_message_save.unwrap_or(false) {
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

            // Freeze and persist a per-variant plan before the crash-safe assistant skeleton is
            // written. The execution task recompiles independently and later fills actual route.
            let mut variant_options = options.clone();
            variant_options.model_id = Some(config_id.clone());
            variant_options.model2_override_id = Some(config_id.clone());
            let mut freeze_ctx = PipelineContext::new(SendMessageRequest {
                session_id: session_id.clone(),
                content: user_content.clone(),
                options: Some(variant_options),
                user_message_id: Some(user_message_id.clone()),
                assistant_message_id: Some(assistant_message_id.clone()),
                user_context_refs: request.user_context_refs.clone(),
                path_map: request.path_map.clone(),
                workspace_id: request.workspace_id.clone(),
            });
            freeze_ctx.init_context_snapshot();
            self.freeze_execution_context(&mut freeze_ctx).await?;
            ctx.set_meta(crate::chat_v2::types::VariantMeta {
                execution_snapshot: freeze_ctx.execution_snapshot,
                ..Default::default()
            });

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
                    let mut variant = Variant::new_with_id_and_config(
                        ctx.variant_id().to_string(),
                        ctx.model_id().to_string(),
                        ctx.get_config_id().unwrap_or_default(),
                    );
                    variant.meta = ctx.get_meta();
                    variant
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
                    execution_snapshot: None,
                    canonical_content: None,
                    chat_params: Some(serde_json::json!({
                        "reasoningEffort": options.reasoning_effort,
                        "thinkingBudget": options.thinking_budget,
                        "multiVariantMode": true,
                    })),
                    sources: None,
                    tool_results: None,
                    anki_cards: None,
                    usage: None,
                    context_snapshot: None,
                    skill_snapshot_before: None,
                    skill_snapshot_after: None,
                    skill_runtime_before: build_replay_skill_payload_snapshot(&options),
                    skill_runtime_after: build_replay_skill_payload_snapshot(&options),
                    replay_source: None,
                    response_reasoning_items: None,
                    skill_injection_anchors: None,
                    response_web_search_items: None,
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
        // ★ 2026-03 修复：共享 user_context_refs 给所有变体，确保多模态内容不丢失
        let context_refs_arc = Arc::new(request.user_context_refs.clone().unwrap_or_default());
        // P1 tools 前缀代际（方案 A）：spawn 之前一次性快照 (g, B_g)，Arc
        // 分发给所有变体 —— 消除变体内独立 load 的轮内竞态，同一扇出内
        // 所有变体从同一字节基线出发。环内只推进本地副本，join 之后在
        // converge_session_tool_face_prefix 收敛点统一写回。
        let tool_face_baseline_arc = Arc::new(self.load_session_tool_face_prefix(&session_id));

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
            let context_refs_clone = Arc::clone(&context_refs_arc);
            let state_clone = chat_v2_state.clone();
            let variant_meta_clone = ctx.get_meta();
            let tool_face_baseline_clone = Arc::clone(&tool_face_baseline_arc);

            let future = async move {
                self_ref.execute_single_variant_with_config(
                    ctx_clone,
                    config_id_clone,  // 传递 API 配置 ID
                    variant_meta_clone,
                    (*options_clone).clone(),
                    (*user_content_clone).clone(),
                    (*session_id_clone).clone(),
                    shared_ctx,
                    Vec::new(),
                    (*context_refs_clone).clone(),
                    tool_face_baseline_clone,
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

        // P1 tools 前缀代际（方案 A）：join 收敛点。所有变体的工具环与其
        // hook 生命周期已经结束，这里按**变体索引序**（不是完成竞态序）
        // 收集各变体本地快照（VariantMeta.tool_face_prefix，含 order 与
        // 窗口 digest；变体环内只推本地、不写共享），确定性合并回会话
        // 基线；检出真分叉（互异且不可 append-only 对齐的尾部）时
        // generation += 1，digest 按共识规则采纳。锁内合并克隆、
        // 放锁后写库（advance 失败仅 warn，不阻断）。
        {
            let variant_local_prefixes: Vec<(
                usize,
                crate::chat_v2::types::ToolFacePrefixSnapshot,
            )> = variant_contexts
                .iter()
                .enumerate()
                .filter_map(|(variant_index, (ctx, _))| {
                    ctx.get_meta()
                        .and_then(|meta| meta.tool_face_prefix)
                        .map(|prefix| (variant_index, prefix))
                })
                .collect();
            if !variant_local_prefixes.is_empty() {
                self.converge_session_tool_face_prefix(&session_id, &variant_local_prefixes);
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
        let save_result = self
            .save_multi_variant_results(
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
                canonical_content,
                user_execution_snapshot,
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

        if let Err(e) = save_result {
            // 🔧 P0 修复：终态事件必须互斥且只发一次 —— 保存失败只发
            // stream_error，不再补发 stream_complete（先 error 后 complete
            // 会让前端把会话覆盖为「已完成」，吞掉错误态）。
            emitter.emit_stream_error(&assistant_message_id, &e.to_string());
            return Err(e);
        }

        // === 12. 发射 stream_complete（带汇总 token 统计） ===
        let duration_ms = start_time.elapsed().as_millis() as u64;
        // 🆕 汇总所有变体的 usage 到会话级 complete 事件；
        // 变体级明细仍通过 variant_end 事件与 Variant.usage 持久化字段传递
        let aggregated_usage = {
            let mut total = TokenUsage::zero();
            for (variant_ctx, _) in &variant_contexts {
                let usage = variant_ctx.get_usage();
                if usage.has_tokens() {
                    total.accumulate(&usage);
                }
            }
            total.has_tokens().then_some(total)
        };
        emitter.emit_stream_complete_with_usage(
            &assistant_message_id,
            duration_ms,
            aggregated_usage.as_ref(),
        );

        log::info!(
            "[ChatV2::pipeline] Multi-variant pipeline completed in {}ms",
            duration_ms
        );

        // 🆕 多变体模式：对话后自动记忆提取（使用 active_variant 的内容）
        // 与单变体路径共用 persistence.rs::trigger_auto_memory_extraction_for_turn，
        // 门控（会话 memory_enabled / 频率 / 隐私 / 长度 / 竞态）单一实现，消除镜像漂移
        if let Some(active_id) = &active_variant_id {
            if let Some((active_ctx, _)) = variant_contexts
                .iter()
                .find(|(ctx, _)| ctx.variant_id() == active_id.as_str())
            {
                self.trigger_auto_memory_extraction_for_turn(
                    options.memory_enabled,
                    &user_content,
                    &active_ctx.get_accumulated_content(),
                    &active_ctx.get_tool_results(),
                    "AutoMemory::MultiVariant",
                );
            }
        }

        // 🔧 自动生成会话元数据（多变体模式，首轮唯一）
        // 使用 active_variant 的内容来生成元数据
        if let Some(active_id) = &active_variant_id {
            if let Some((active_ctx, _)) = variant_contexts
                .iter()
                .find(|(ctx, _)| ctx.variant_id() == active_id.as_str())
            {
                let assistant_content = active_ctx.get_accumulated_content();
                if self
                    .should_generate_session_metadata(
                        &session_id,
                        &user_content,
                        &assistant_content,
                    )
                    .await
                {
                    let pipeline = self.clone();
                    let sid = session_id.clone();
                    let emitter_clone = emitter.clone();
                    let user_content_clone = user_content.clone();

                    let summary_future = async move {
                        pipeline
                            .generate_session_metadata(
                                &sid,
                                &user_content_clone,
                                &assistant_content,
                                emitter_clone,
                            )
                            .await;
                    };

                    if let Some(ref state) = chat_v2_state {
                        state.spawn_tracked(summary_future);
                    } else {
                        log::warn!("[ChatV2::pipeline] spawn_tracked unavailable, using untracked tokio::spawn for metadata task (multi-variant)");
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
    /// - `attachments`: 附件列表（旧版 retry 路径兼容）
    /// - `user_context_refs`: 用户上下文引用（含多模态 formattedBlocks）
    async fn execute_single_variant(
        &self,
        ctx: Arc<super::super::variant_context::VariantExecutionContext>,
        mut options: SendOptions,
        user_content: String,
        session_id: String,
        shared_context: Arc<SharedContext>,
        attachments: Vec<AttachmentInput>,
        user_context_refs: Vec<SendContextRef>,
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

        // 构建系统提示（P1-10 拆分：稳定 system + turn-volatile 块，
        // 共享检索结果随 turn-volatile 进入当前 user 的 <injected_context>）
        let prompt_parts = self
            .build_system_prompt_with_shared_context(&options, &shared_context)
            .await;
        let system_prompt = prompt_parts.stable_system;

        // 加载聊天历史
        let mut chat_history = self
            .load_variant_chat_history(&session_id, Some(ctx.message_id()), options.context_limit)
            .await?;
        // load_variant_chat_history excludes this attempt's persisted user/assistant rows by id.
        // Do not infer duplicates from message text: consecutive identical prompts are valid.
        // 🔧 Token 预算裁剪（对齐单变体路径）
        // 🔧 P1-2 修复：context_limit 显式配置时为权威值，不再被 32K 常量 min() 钳制
        let max_tokens = effective_history_token_budget(options.context_limit);
        trim_history_by_token_budget(&mut chat_history, max_tokens);

        // 构建当前用户消息（turn-volatile 块编入 <injected_context>）
        let current_user_message = self.build_variant_user_message(
            &user_content,
            &attachments,
            &user_context_refs,
            prompt_parts.turn_volatile.as_deref(),
        );

        // 创建 LLM 适配器（使用变体的事件发射）
        let enable_thinking = options.enable_thinking.unwrap_or(true);
        let wrap_token_policy = self
            .resolve_api_config_by_id(options.model_id.as_deref())
            .await
            .map(|config| {
                crate::utils::model_special_tokens::ModelWrapTokenPolicy::for_provider_model(
                    config.provider_type.as_deref(),
                    config.provider_scope.as_deref(),
                    &config.model,
                )
            })
            .unwrap_or(crate::utils::model_special_tokens::ModelWrapTokenPolicy::Disabled);
        let emitter = Arc::new(VariantLLMAdapter::new(
            Arc::clone(&ctx),
            enable_thinking,
            options.skill_state_version,
            Some("variant-tool-round-0".to_string()),
            wrap_token_policy,
        ));

        // Each concrete variant attempt gets a unique hook key. Variant IDs are reused by retry,
        // so `{session}:{variant}` alone is not an ownership identity.
        let stream_event = super::tool_loop::build_run_scoped_stream_event(
            &session_id,
            ctx.variant_id(),
            &Uuid::new_v4().simple().to_string(),
            options.stream_generation,
        );
        let registered_hooks: Arc<dyn LLMStreamHooks> = emitter.clone();
        let mut hooks_guard = super::tool_loop::StreamHooksGuard::new(
            self.llm_manager.clone(),
            stream_event.clone(),
            registered_hooks.clone(),
        );
        self.llm_manager
            .register_stream_hooks(&stream_event, registered_hooks.clone())
            .await;

        // 构建消息历史
        let base_history_len = chat_history.len();
        let mut messages = chat_history;
        messages.push(current_user_message);

        let variant_skill_state = ctx
            .get_meta()
            .and_then(|meta| meta.skill_snapshot_after.or(meta.skill_snapshot_before))
            .map(|snapshot| session_skill_state_from_snapshot(&snapshot))
            .unwrap_or_else(|| self.load_effective_session_skill_state(&session_id, &options));
        let empty_skill_contents = std::collections::HashMap::new();
        // P1-8 技能锚定：历史中已锚定的技能不重复注入（注入点冻结），本轮只注入差集。
        let anchored_skill_ids = anchored_skill_ids_in_history(&messages);
        let turn_skill_injection = build_transient_skill_messages_with_audit_excluding(
            &variant_skill_state,
            options
                .replay_skill_contents
                .as_ref()
                .or(options.skill_contents.as_ref())
                .unwrap_or(&empty_skill_contents),
            options.skill_dependencies.as_ref(),
            // 🔧 P1-2 修复：context_limit 显式配置时为权威值，不再被 32K 常量 min() 钳制
            options.context_limit.map(|v| v as usize),
            &anchored_skill_ids,
        );
        insert_transient_skill_messages(
            &mut messages,
            base_history_len,
            turn_skill_injection.messages,
        );

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
        llm_context.insert(
            "memory_enabled".into(),
            Value::Bool(options.memory_enabled.unwrap_or(true)),
        );
        llm_context.insert(
            "rag_enabled".into(),
            Value::Bool(options.rag_enabled.unwrap_or(true)),
        );
        llm_context.insert(
            "web_search_enabled".into(),
            Value::Bool(options.web_search_enabled.unwrap_or(true)),
        );

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
                let (whitelist, blacklist) = load_mcp_tool_policy(self.main_db.as_ref());
                let mut mcp_tool_values: Vec<Value> = tool_schemas
                    .iter()
                    .filter(|tool| {
                        is_mcp_tool_allowed_by_policy(tool, &whitelist, &blacklist)
                    })
                    .filter_map(|tool| {
                        let Some(prepared) = prepare_external_tool_schema(tool, false) else {
                            log::warn!(
                                "[ChatV2::VariantPipeline] Skipping MCP tool with blank API name: raw='{}'",
                                external_tool_raw_name(&tool.name)
                            );
                            return None;
                        };
                        Some(prepared.schema)
                    })
                    .collect();

                if !mcp_tool_values.is_empty() {
                    // G6：LLM 管线只读 `custom_tools`，写 `tools` 是死键；
                    // 排序保证 prompt cache 前缀稳定。
                    super::tool_loop::sort_tool_schemas_for_prompt_cache(&mut mcp_tool_values);
                    let injected_count = mcp_tool_values.len();
                    llm_context.insert("custom_tools".into(), Value::Array(mcp_tool_values));
                    log::info!(
                        "[ChatV2::VariantPipeline] execute_single_variant: variant={} injected {} tools",
                        ctx.variant_id(),
                        injected_count
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
            Some(ctx.message_id()),
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
            options.reasoning_effort.clone(),
            options.thinking_budget,
        );

        // 🔧 F2 修复：空闲超时 + 绝对上限（替代总时长 600s 掐断健康长流）
        // 🔧 2026-07：空闲阈值/是否断流按请求读取 chat.stream.* 设置
        let stream_idle_cfg = load_stream_idle_config(self.main_db.as_ref());
        let call_result = {
            let adapter_for_idle = emitter.clone();
            match wait_llm_stream_with_idle_timeout(
                llm_future,
                stream_idle_cfg.idle_limit,
                Duration::from_secs(LLM_STREAM_MAX_TOTAL_SECS),
                stream_idle_cfg.cancel_on_idle,
                move || adapter_for_idle.idle_elapsed(),
            )
            .await
            {
                LlmStreamWaitOutcome::Completed(result) => result,
                LlmStreamWaitOutcome::IdleTimeout { idle_secs } => {
                    log::error!(
                        "[ChatV2::VariantPipeline] LLM stream idle timeout after {}s, variant={}",
                        idle_secs,
                        ctx.variant_id()
                    );
                    hooks_guard.cleanup().await;
                    let msg = format!("LLM stream timed out: no data received for {}s", idle_secs);
                    ctx.fail(&msg);
                    return Err(ChatV2Error::Timeout(msg));
                }
                LlmStreamWaitOutcome::TotalTimeout { total_secs } => {
                    log::error!(
                        "[ChatV2::VariantPipeline] LLM stream exceeded absolute limit {}s, variant={}",
                        total_secs,
                        ctx.variant_id()
                    );
                    hooks_guard.cleanup().await;
                    let msg = format!("LLM stream exceeded absolute time limit ({}s)", total_secs);
                    ctx.fail(&msg);
                    return Err(ChatV2Error::Timeout(msg));
                }
            }
        };

        // 注销 hooks
        hooks_guard.cleanup().await;

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
        variant_meta: Option<crate::chat_v2::types::VariantMeta>,
        mut options: SendOptions,
        user_content: String,
        session_id: String,
        shared_context: Arc<SharedContext>,
        attachments: Vec<AttachmentInput>,
        user_context_refs: Vec<SendContextRef>,
        // P1 tools 前缀代际（方案 A）：fan-out 入口统一快照 (g, B_g)。
        // 变体环内只推进本地 order 克隆、不写共享态；generation 写入口
        // 代际（变体内不自增），join 收敛点统一合并 + 切代判定。
        tool_face_baseline: Arc<ToolFaceBaseline>,
    ) -> ChatV2Result<()> {
        // 🔧 2026-07: 变体工具循环上限与单变体路径统一。
        // 之前硬编码 `MAX_TOOL_ROUNDS = 10`，与单变体路径「用户可配 1-100、
        // 默认 MAX_TOOL_RECURSION(30)」不一致（短板 13）。现在与
        // tool_loop.rs execute_with_tools 共用 constants.rs 的
        // effective_max_tool_rounds（默认值/clamp 逻辑单点维护）。
        // 注意：变体内无心跳白名单豁免（coordinator_sleep 在多变体模式下不适用），
        // 因此不需要 ABSOLUTE_MAX_RECURSION 二级上限。
        let max_tool_rounds: u32 = effective_max_tool_rounds(options.max_tool_recursion);

        options.model_id = Some(config_id.clone());
        options.model2_override_id = Some(config_id.clone());

        if ctx.is_cancelled() {
            ctx.cancel();
            return Ok(());
        }

        // Each variant owns an independent frozen capability snapshot and compiler context.
        // This must happen before variant_start so UI changes or another variant's model cannot
        // affect the in-flight request.
        let compile_request = SendMessageRequest {
            session_id: session_id.clone(),
            content: user_content.clone(),
            options: Some(options.clone()),
            user_message_id: None,
            assistant_message_id: Some(ctx.message_id().to_string()),
            user_context_refs: Some(user_context_refs.clone()),
            path_map: None,
            workspace_id: None,
        };
        let mut compile_ctx = PipelineContext::new(compile_request);
        compile_ctx.init_context_snapshot();
        compile_ctx.set_cancellation_token(ctx.cancel_token().clone());
        if user_context_refs.is_empty() {
            if let Some(mut canonical) =
                self.load_source_user_canonical_for_assistant(&session_id, ctx.message_id())?
            {
                canonical.retain(|part| {
                    !matches!(
                        part,
                        crate::chat_v2::types::CanonicalContentPart::DerivedArtifactRef { .. }
                    )
                });
                if let Some(artifacts) = variant_meta
                    .as_ref()
                    .and_then(|meta| meta.canonical_artifacts.as_ref())
                {
                    canonical.extend(artifacts.iter().cloned());
                }
                compile_ctx.canonical_content = canonical;
            }
        }
        self.freeze_execution_context(&mut compile_ctx).await?;
        options = compile_ctx.options.clone();

        // P1-10：先拆分系统提示——稳定 system 留给 LLM 调用，
        // turn-volatile 块（共享检索/画像/待办/Canvas）写入 compile_ctx，
        // 使其随 compile_frozen_context 编入当前 user 的 <injected_context>
        let prompt_parts = self
            .build_system_prompt_with_shared_context(&options, &shared_context)
            .await;
        compile_ctx.turn_volatile_context = prompt_parts.turn_volatile.clone();

        let mut chat_history = self
            .load_variant_chat_history(&session_id, Some(ctx.message_id()), options.context_limit)
            .await?;
        // 🔧 Token 预算裁剪（对齐单变体路径）
        // 🔧 P1-2 修复：context_limit 显式配置时为权威值，不再被 32K 常量 min() 钳制
        let max_tokens_budget = effective_history_token_budget(options.context_limit);
        trim_history_by_token_budget(&mut chat_history, max_tokens_budget);
        compile_ctx.chat_history = chat_history;
        self.compile_frozen_context(&mut compile_ctx).await?;
        let mut effective_meta = variant_meta.unwrap_or_default();
        effective_meta.execution_snapshot = compile_ctx.execution_snapshot.clone();
        let artifacts: Vec<_> = compile_ctx
            .canonical_content
            .iter()
            .filter(|part| {
                matches!(
                    part,
                    crate::chat_v2::types::CanonicalContentPart::DerivedArtifactRef { .. }
                )
            })
            .cloned()
            .collect();
        effective_meta.canonical_artifacts = (!artifacts.is_empty()).then_some(artifacts);
        ctx.set_meta(effective_meta);

        ctx.start_streaming();

        let system_prompt = prompt_parts.stable_system;
        let turn_volatile = prompt_parts.turn_volatile;
        let chat_history = compile_ctx.chat_history;
        let current_user_message = compile_ctx
            .compiled_current_user_message
            .unwrap_or_else(|| {
                self.build_variant_user_message(
                    &user_content,
                    &attachments,
                    &user_context_refs,
                    turn_volatile.as_deref(),
                )
            });

        let enable_thinking = options.enable_thinking.unwrap_or(true);
        let max_input_tokens_override = options.context_limit.map(|v| v as usize);
        let has_tools = options
            .mcp_tool_schemas
            .as_ref()
            .map(|s| !s.is_empty())
            .unwrap_or(false);
        let disable_tools = options.disable_tools.unwrap_or(false) || !has_tools;

        let base_history_len = chat_history.len();
        let mut messages = chat_history;
        messages.push(current_user_message);

        let wrap_token_policy = self
            .resolve_api_config_by_id(options.model_id.as_deref())
            .await
            .map(|config| {
                crate::utils::model_special_tokens::ModelWrapTokenPolicy::for_provider_model(
                    config.provider_type.as_deref(),
                    config.provider_scope.as_deref(),
                    &config.model,
                )
            })
            .unwrap_or(crate::utils::model_special_tokens::ModelWrapTokenPolicy::Disabled);
        let adapter = Arc::new(VariantLLMAdapter::new(
            Arc::clone(&ctx),
            enable_thinking,
            options.skill_state_version,
            Some("variant-tool-round-0".to_string()),
            wrap_token_policy,
        ));
        let stream_event = super::tool_loop::build_run_scoped_stream_event(
            &session_id,
            ctx.variant_id(),
            &Uuid::new_v4().simple().to_string(),
            options.stream_generation,
        );
        let registered_hooks: Arc<dyn LLMStreamHooks> = adapter.clone();
        let mut hooks_guard = super::tool_loop::StreamHooksGuard::new(
            self.llm_manager.clone(),
            stream_event.clone(),
            registered_hooks.clone(),
        );
        self.llm_manager
            .register_stream_hooks(&stream_event, registered_hooks.clone())
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
        llm_context.insert(
            "memory_enabled".into(),
            Value::Bool(options.memory_enabled.unwrap_or(true)),
        );
        llm_context.insert(
            "rag_enabled".into(),
            Value::Bool(options.rag_enabled.unwrap_or(true)),
        );
        llm_context.insert(
            "web_search_enabled".into(),
            Value::Bool(options.web_search_enabled.unwrap_or(true)),
        );

        // 🆕 图片压缩策略：从 options 获取或使用默认值
        let vq = options.vision_quality.as_deref().unwrap_or("auto");
        llm_context.insert("vision_quality".into(), Value::String(vq.to_string()));

        // 🔧 工具名称映射：sanitized API name → original name
        let mut variant_tool_name_mapping: HashMap<String, super::tool_loop::ExternalToolRoute> =
            HashMap::new();
        let (whitelist, blacklist) = load_mcp_tool_policy(self.main_db.as_ref());

        // P0（DESIGN「tools 会话内冻结」）+ P1 代际（方案 A）：tools 顺序
        // 基线（append-only 首见序）来自 fan-out 入口统一快照的克隆 ——
        // 同一扇出内所有变体从同一字节基线出发（消除旧「变体内独立 load」
        // 的轮内竞态）。环内 load_skills 刷新全量重建时按基线还原顺序，
        // 新工具只追加末尾、只推进本**地**副本；不再中途写回共享态，
        // 收敛统一在 join 之后的 converge_session_tool_face_prefix。
        let mut frozen_tool_schema_order: Vec<String> = tool_face_baseline.order.clone();
        // P0 字节级冻结（与单变体 execute_with_tools 同语义）：本变体工具环
        // = 一个稳定窗口，已发出工具的 schema 序列化字节窗口内冻结（同名
        // 变更延迟到下一稳定窗口），新工具只追加末尾。窗口级本地持有，
        // 不写共享态、不中途写回。
        let mut frozen_tool_schemas: HashMap<String, Value> = HashMap::new();
        // 本变体窗口冻结快照 digest：从 fan-out 入口基线 digest 起步，每次
        // 统一冻结原语返回 Some 时推进；空窗口保持基线值（None 不抹掉已有
        // digest）。变体结束时随 VariantMeta.tool_face_prefix 交 join 收敛
        // 点评估，变体内不切代。
        let mut variant_schema_digest: Option<String> = tool_face_baseline.schema_digest.clone();

        if !disable_tools {
            if let Some(ref tool_schemas) = options.mcp_tool_schemas {
                let mut mcp_tool_values: Vec<Value> = tool_schemas
                    .iter()
                    .filter(|tool| {
                        is_mcp_tool_allowed_by_policy(tool, &whitelist, &blacklist)
                    })
                    .filter_map(|tool| {
                        let Some(prepared) = prepare_external_tool_schema(tool, true) else {
                            log::warn!(
                                "[ChatV2::VariantPipeline] Skipping MCP tool with blank API name: raw='{}'",
                                external_tool_raw_name(&tool.name)
                            );
                            return None;
                        };
                        if tool
                            .server_id
                            .as_deref()
                            .is_some_and(|server_id| server_id.trim().is_empty())
                        {
                            log::warn!(
                                "[ChatV2::VariantPipeline] Ignoring blank MCP server id for tool '{}'",
                                prepared.raw_tool_name
                            );
                        }
                        variant_tool_name_mapping.insert(
                            prepared.api_name.clone(),
                            super::tool_loop::ExternalToolRoute {
                                raw_tool_name: prepared.raw_tool_name,
                                preferred_server_id: prepared.preferred_server_id,
                            },
                        );
                        Some(prepared.schema)
                    })
                    .collect();

                if !mcp_tool_values.is_empty() {
                    // G6 + P0 冻结：LLM 管线只读 `custom_tools`，写 `tools` 是
                    // 死键；首轮按名字排序建立基线并冻结（统一冻结原语 =
                    // 名字序 + 字节冻结 + digest），供环内刷新复用。
                    // P1 代际：只推进本地 order/digest，不中途写回共享态
                    // （写回统一在 join 收敛点）。
                    if let Some(digest) = super::tool_loop::freeze_tool_face_for_prompt_cache(
                        &mut mcp_tool_values,
                        &mut frozen_tool_schema_order,
                        &mut frozen_tool_schemas,
                    ) {
                        variant_schema_digest = Some(digest);
                    }
                    let injected_count = mcp_tool_values.len();
                    llm_context.insert("custom_tools".into(), Value::Array(mcp_tool_values));
                    log::info!(
                        "[ChatV2::VariantPipeline] variant={} injected {} tools",
                        ctx.variant_id(),
                        injected_count
                    );
                }
            }
        }

        let emitter_arc = ctx.emitter_arc();
        let canvas_note_id = options.canvas_note_id.clone();
        let active_skill_ids = options.active_skill_ids.clone();
        let skill_contents = options.skill_contents.clone();
        let mut variant_skill_state = ctx
            .get_meta()
            .and_then(|meta| meta.skill_snapshot_after.or(meta.skill_snapshot_before))
            .map(|snapshot| session_skill_state_from_snapshot(&snapshot))
            .unwrap_or_else(|| self.load_effective_session_skill_state(&session_id, &options));

        // ============================================================
        // P1-8 技能锚定：本轮注入只在进入工具环前构建并插入一次（位置 =
        // 历史末尾、当前 user 之前），之后冻结 —— 禁止每轮删光后整包重插
        // 到当前 user 之前（那会改写同轮内存前缀）。环内 load_skills 新
        // 加载的技能按 tool_call_id 追加到对应 tool result 之后。
        // ============================================================
        let mut injected_skill_ids = anchored_skill_ids_in_history(&messages);
        let turn_skill_injection = {
            let empty_skill_contents = std::collections::HashMap::new();
            build_transient_skill_messages_with_audit_excluding(
                &variant_skill_state,
                options
                    .replay_skill_contents
                    .as_ref()
                    .or(options.skill_contents.as_ref())
                    .unwrap_or(&empty_skill_contents),
                options.skill_dependencies.as_ref(),
                // 🔧 P1-2 修复（对齐单变体 tool_loop）：context_limit 显式配置时为权威值，
                // 不再被 32K 常量 min() 钳制，消除多变体/单变体双路径漂移
                options.context_limit.map(|v| v as usize),
                &injected_skill_ids,
            )
        };
        injected_skill_ids.extend(
            turn_skill_injection
                .audit
                .injected_skill_ids
                .iter()
                .cloned(),
        );
        let mut cumulative_skill_audit = turn_skill_injection.audit.clone();
        insert_transient_skill_messages(
            &mut messages,
            base_history_len,
            turn_skill_injection.messages,
        );

        let mut tool_round = 0u32;
        // 🆕 2026-07 Doom loop 检测：变体局部守卫（变体间互不影响），
        // 与单变体路径共用 apply_doom_loop_guard（tool_loop.rs）
        let mut doom_loop_guard = crate::chat_v2::context::DoomLoopGuard::default();
        loop {
            if ctx.is_cancelled() {
                ctx.cancel();
                break;
            }

            let skill_audit = cumulative_skill_audit.clone();
            let audit_round_id = format!("variant-tool-round-{}", tool_round);
            emitter_arc.emit_skill_injection_audit(
                ctx.message_id(),
                json!({
                    "injectedSkillIds": skill_audit.injected_skill_ids.clone(),
                    "droppedSkillIds": skill_audit.dropped_skill_ids.clone(),
                    "missingSkillIds": skill_audit.missing_skill_ids.clone(),
                    "estimatedTokens": skill_audit.estimated_tokens,
                    "skillStateVersion": skill_audit.skill_state_version,
                }),
                Some(ctx.variant_id()),
                Some(skill_audit.skill_state_version),
                Some(audit_round_id.as_str()),
            );

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
                Some(ctx.message_id()),
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
                options.reasoning_effort.clone(),
                options.thinking_budget,
            );

            // 使用 tokio::select! 支持取消（与单变体 pipeline 对齐）
            // 🔧 F2 修复：空闲超时 + 绝对上限（替代总时长 600s 掐断健康长流）
            // 🔧 2026-07：空闲阈值/是否断流按请求读取 chat.stream.* 设置
            let stream_idle_cfg = load_stream_idle_config(self.main_db.as_ref());
            let call_result = tokio::select! {
                outcome = {
                    let adapter_for_idle = adapter.clone();
                    wait_llm_stream_with_idle_timeout(
                        llm_future,
                        stream_idle_cfg.idle_limit,
                        Duration::from_secs(LLM_STREAM_MAX_TOTAL_SECS),
                        stream_idle_cfg.cancel_on_idle,
                        move || adapter_for_idle.idle_elapsed(),
                    )
                } => {
                    match outcome {
                        LlmStreamWaitOutcome::Completed(r) => Some(r),
                        LlmStreamWaitOutcome::IdleTimeout { idle_secs } => {
                            log::error!(
                                "[ChatV2::VariantPipeline] LLM stream idle timeout after {}s, variant={}, round={}",
                                idle_secs,
                                ctx.variant_id(),
                                tool_round
                            );
                            hooks_guard.cleanup().await;
                            let msg = format!(
                                "LLM stream timed out: no data received for {}s",
                                idle_secs
                            );
                            ctx.fail(&msg);
                            return Err(ChatV2Error::Timeout(msg));
                        }
                        LlmStreamWaitOutcome::TotalTimeout { total_secs } => {
                            log::error!(
                                "[ChatV2::VariantPipeline] LLM stream exceeded absolute limit {}s, variant={}, round={}",
                                total_secs,
                                ctx.variant_id(),
                                tool_round
                            );
                            hooks_guard.cleanup().await;
                            let msg = format!(
                                "LLM stream exceeded absolute time limit ({}s)",
                                total_secs
                            );
                            ctx.fail(&msg);
                            return Err(ChatV2Error::Timeout(msg));
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
                    hooks_guard.cleanup().await;
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
            let memory_enabled = options.memory_enabled.unwrap_or(true);
            let rag_enabled = options.rag_enabled.unwrap_or(true);
            let web_search_enabled = options.web_search_enabled.unwrap_or(true);
            let execution_allowed_tools = options.execution_allowed_tools.clone();
            let round_id = format!("variant-tool-round-{}", tool_round);

            // 🆕 2026-07 Doom loop 检测：拦截连续重复调用（同工具同参数第 3 次起），
            // 合成失败结果回喂 LLM；第 5 次落终止标记，本轮结果回喂后终止变体循环
            let (calls_to_execute, doom_synthetic) = self.apply_doom_loop_guard(
                &mut doom_loop_guard,
                &tool_calls,
                &emitter_arc,
                ctx.message_id(),
                Some(ctx.variant_id()),
                options.skill_state_version,
                Some(round_id.as_str()),
            );

            // 🔧 F9 修复：传真实 session_id（之前是 "{session}:{variant}" 复合键，
            // 导致所有按 session 查库的工具——子代理/附件/技能状态/所有权校验——在
            // 变体模式下全部失效）。变体间内存状态隔离改由 variant_id 参数承担
            // （todo_executor 内部组合 session_id+variant_id 作为隔离键）。
            let executed_results = if calls_to_execute.is_empty() {
                Vec::new()
            } else {
                self.execute_tool_calls(
                    &calls_to_execute,
                    &emitter_arc,
                    &session_id,
                    ctx.message_id(),
                    Some(ctx.variant_id()),
                    options.skill_state_version,
                    Some(round_id.as_str()),
                    &canvas_note_id,
                    &skill_contents,
                    &options.skill_embedded_tools,
                    &options.skill_admission_errors,
                    &options.skill_package_roots,
                    &active_skill_ids,
                    &execution_allowed_tools,
                    cancel_token,
                    rag_top_k,
                    rag_enable_reranking,
                    memory_enabled,
                    rag_enabled,
                    web_search_enabled,
                    &variant_tool_name_mapping,
                )
                .await?
            };
            // 合成失败结果按原始 tool_calls 顺序归并（保证协议完整性与历史确定性）
            let tool_results = super::tool_loop::merge_round_results_in_call_order(
                &tool_calls,
                executed_results,
                doom_synthetic,
            );

            let success_count = tool_results.iter().filter(|r| r.success).count();
            log::info!(
                "[ChatV2::VariantPipeline] variant={} tool execution: {}/{} succeeded",
                ctx.variant_id(),
                success_count,
                tool_results.len()
            );

            // P1-8：本轮环内新加载的技能批次（tool_call_id → 消息），
            // 在工具结果消息 push 完成后插到对应 tool result 之后
            let mut pending_round_skill_batches: Vec<(String, Vec<LegacyChatMessage>)> = Vec::new();

            // 🔧 渐进披露：load_skills 执行后动态追加工具
            for tool_result in &tool_results {
                if super::super::tools::SkillsExecutor::is_load_skills_tool(&tool_result.tool_name)
                    && tool_result.success
                {
                    if let Some(skill_ids) = tool_result
                        .output
                        .get("result")
                        .and_then(|r| r.get("loaded_skill_ids").or_else(|| r.get("skill_ids")))
                        .and_then(|ids| ids.as_array())
                    {
                        let loaded_skill_ids: Vec<String> = skill_ids
                            .iter()
                            .filter_map(|id| id.as_str().map(|s| s.to_string()))
                            .collect();

                        if !loaded_skill_ids.is_empty() {
                            if let Some(ref embedded_tools_map) = options.skill_embedded_tools {
                                // 追加工具 Schema 到 mcp_tool_schemas
                                let mcp_schemas =
                                    options.mcp_tool_schemas.get_or_insert_with(Vec::new);
                                let mut existing_names: std::collections::HashSet<String> =
                                    mcp_schemas.iter().map(|t| t.name.clone()).collect();
                                let mut added_count = 0;
                                for skill_id in &loaded_skill_ids {
                                    if let Some(tools) = embedded_tools_map.get(skill_id) {
                                        for tool in tools {
                                            if !existing_names.contains(&tool.name) {
                                                mcp_schemas.push(tool.clone());
                                                existing_names.insert(tool.name.clone());
                                                added_count += 1;
                                            }
                                        }
                                    }
                                }
                                if added_count > 0 {
                                    log::info!(
                                        "[ChatV2::VariantPipeline] 🆕 Progressive disclosure: added {} tools from skills {:?}",
                                        added_count,
                                        loaded_skill_ids,
                                    );
                                    let mut refreshed_tools: Vec<Value> = mcp_schemas
                                        .iter()
                                        .filter(|tool| {
                                            is_mcp_tool_allowed_by_policy(
                                                tool,
                                                &whitelist,
                                                &blacklist,
                                            )
                                        })
                                        .filter_map(|tool| {
                                            let Some(prepared) =
                                                prepare_external_tool_schema(tool, true)
                                            else {
                                                log::warn!(
                                                    "[ChatV2::VariantPipeline] Skipping refreshed MCP tool with blank API name: raw='{}'",
                                                    external_tool_raw_name(&tool.name)
                                                );
                                                return None;
                                            };
                                            variant_tool_name_mapping.insert(
                                                prepared.api_name.clone(),
                                                super::tool_loop::ExternalToolRoute {
                                                    raw_tool_name: prepared.raw_tool_name,
                                                    preferred_server_id: prepared
                                                        .preferred_server_id,
                                                },
                                            );
                                            Some(prepared.schema)
                                        })
                                        .collect();
                                    // G6 + P0 冻结：LLM 管线只读 `custom_tools`，
                                    // 写 `tools` 是死键。全量重建后按冻结基线还原
                                    // 已发出顺序（统一冻结原语：名字序 + 已发出
                                    // schema 字节窗口内回写），新技能工具只追加
                                    // 末尾，禁止字母序插入中段。
                                    // P1 代际：只推进本地 order/digest，不中途写
                                    // 回共享态（写回统一在 join 收敛点）。
                                    if let Some(digest) =
                                        super::tool_loop::freeze_tool_face_for_prompt_cache(
                                            &mut refreshed_tools,
                                            &mut frozen_tool_schema_order,
                                            &mut frozen_tool_schemas,
                                        )
                                    {
                                        variant_schema_digest = Some(digest);
                                    }
                                    llm_context.insert(
                                        "custom_tools".into(),
                                        Value::Array(refreshed_tools),
                                    );
                                }
                            }
                            variant_skill_state = variant_skill_state
                                .with_added_branch_local_skills(&loaded_skill_ids);
                            options.skill_state_version = Some(variant_skill_state.version);

                            // P1-8 环内技能锚定：新加载技能（差集）锚到本次
                            // load_skills 的 tool result 之后，禁止整包重插到
                            // 当前 user 之前
                            if let Some(anchor_call_id) =
                                tool_result.tool_call_id.clone().filter(|id| !id.is_empty())
                            {
                                let empty_skill_contents = std::collections::HashMap::new();
                                let batch = build_in_loop_skill_messages(
                                    &loaded_skill_ids,
                                    options
                                        .replay_skill_contents
                                        .as_ref()
                                        .or(options.skill_contents.as_ref())
                                        .unwrap_or(&empty_skill_contents),
                                    options.skill_dependencies.as_ref(),
                                    options.context_limit.map(|v| v as usize),
                                    &injected_skill_ids,
                                    variant_skill_state.version,
                                );
                                cumulative_skill_audit
                                    .missing_skill_ids
                                    .extend(batch.audit.missing_skill_ids.clone());
                                cumulative_skill_audit
                                    .dropped_skill_ids
                                    .extend(batch.audit.dropped_skill_ids.clone());
                                if !batch.audit.injected_skill_ids.is_empty() {
                                    injected_skill_ids
                                        .extend(batch.audit.injected_skill_ids.iter().cloned());
                                    cumulative_skill_audit
                                        .injected_skill_ids
                                        .extend(batch.audit.injected_skill_ids.iter().cloned());
                                    cumulative_skill_audit.estimated_tokens +=
                                        batch.audit.estimated_tokens;
                                    cumulative_skill_audit.skill_state_version =
                                        variant_skill_state.version;
                                    pending_round_skill_batches
                                        .push((anchor_call_id, batch.messages));
                                }
                            }
                        }
                    }
                }
            }

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

            // P1-8：环内新加载的技能插到对应 load_skills tool result 之后，
            // 当前 user 之前的内存前缀保持逐字节不变
            for (anchor_call_id, batch) in pending_round_skill_batches {
                insert_skill_messages_after_tool_result(&mut messages, &anchor_call_id, batch);
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

            // 🆕 2026-07 Doom loop 终止：同一调用连续第 5 次重复，
            // 拦截结果已回喂本轮 messages，直接终止变体循环（对齐 max rounds 处理）
            if doom_loop_guard.abort_triggered() {
                log::warn!(
                    "[ChatV2::VariantPipeline] variant={} doom loop abort: tool={:?} repeated identical calls, stopping",
                    ctx.variant_id(),
                    doom_loop_guard.abort_tool_name()
                );
                ctx.complete();
                break;
            }

            tool_round += 1;
            ctx.increment_tool_round();

            if tool_round >= max_tool_rounds {
                log::warn!(
                    "[ChatV2::VariantPipeline] variant={} reached max tool rounds ({})",
                    ctx.variant_id(),
                    max_tool_rounds
                );
                ctx.complete();
                break;
            }

            adapter.reset_for_new_round();
        }

        // P1 tools 前缀代际：变体结束时把本地 (generation_in, order_local,
        // digest_local) 写入 VariantMeta.tool_face_prefix —— generation 写
        // 入口代际（变体内不自增，切代判定只属于 join 收敛点），order 是
        // 该变体当轮实际发出的完整工具面序列（入口快照基线 + 本地
        // append-only 尾部），digest 是本变体窗口冻结快照摘要（空窗口保持
        // 入口基线值），供 join 收敛按索引序合并、也供重放逐字节还原。
        {
            let mut meta = ctx.get_meta().unwrap_or_default();
            meta.tool_face_prefix = Some(crate::chat_v2::types::ToolFacePrefixSnapshot {
                generation: tool_face_baseline.generation,
                order: frozen_tool_schema_order.clone(),
                schema_digest: variant_schema_digest.clone(),
            });
            ctx.set_meta(meta);
        }

        hooks_guard.cleanup().await;
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

    /// 构建带共享上下文的系统提示（P1-10 拆分形态）
    ///
    /// 使用 prompt_builder 模块统一格式化，用于多变体并行执行场景。
    /// 返回 `SystemPromptParts`：
    /// - `stable_system`：跨轮字节稳定的 system（LaTeX / instructions /
    ///   preferences / 固定引用规则），作为各变体的 system prompt；
    /// - `turn_volatile`：共享检索结果、Canvas 笔记、画像、待办等本轮动态块，
    ///   注入当前 user 消息的 `<injected_context>`（compile 前写入
    ///   `PipelineContext::turn_volatile_context`），避免打碎历史 prompt cache。
    async fn build_system_prompt_with_shared_context(
        &self,
        options: &SendOptions,
        shared_context: &SharedContext,
    ) -> prompt_builder::SystemPromptParts {
        let canvas_note = self.build_canvas_note_info_from_options(options).await;

        let user_profile = self.load_user_profile_for_variant(options).await;

        let active_todos = self.load_active_todo_summary().await;

        prompt_builder::PromptBuilder::new(options.system_prompt_override.as_deref())
            .with_shared_context(shared_context)
            .with_options(options)
            .with_canvas_note(canvas_note)
            .with_user_profile(user_profile)
            .with_active_todos(active_todos)
            .build_split()
    }

    async fn load_user_profile_for_variant(&self, options: &SendOptions) -> Option<String> {
        use crate::memory::{MemoryCategoryManager, MemoryConfig, MemoryService};
        use crate::vfs::lance_store::VfsLanceStore;

        if options.memory_enabled == Some(false) {
            return None;
        }

        let vfs_db = self.vfs_db.as_ref()?;
        let mem_cfg = MemoryConfig::new(vfs_db.clone());
        if mem_cfg.is_privacy_mode().ok()? {
            return None;
        }
        // 优先复用 app 托管单例（保留 Lance 连接与 ensured_tables 缓存）；
        // 无托管单例（启动降级/测试）时才按需新建。
        let lance_store = match managed_vfs_lance_store_for(vfs_db) {
            Some(store) => store,
            None => match VfsLanceStore::new(vfs_db.clone()) {
                Ok(store) => std::sync::Arc::new(store),
                Err(e) => {
                    log::warn!(
                        "[ChatV2::pipeline] load_user_profile_for_variant: failed to open lance store: {}; skipping profile injection",
                        e
                    );
                    return None;
                }
            },
        };
        let svc = MemoryService::new(vfs_db.clone(), lance_store, self.llm_manager.clone());

        let root_id = match svc.get_root_folder_id() {
            Ok(Some(id)) => id,
            _ => return None,
        };

        let mut sections: Vec<String> = Vec::new();

        let cat_mgr = MemoryCategoryManager::new(vfs_db.clone(), self.llm_manager.clone());
        if let Ok(categories) = cat_mgr.load_all_category_summaries(&root_id) {
            for (cat_name, content) in &categories {
                sections.push(format!("### {}\n{}", cat_name, content));
            }
        }

        if sections.is_empty() {
            return svc.get_profile_summary().ok().flatten();
        }

        let combined = sections.join("\n\n");
        if combined.chars().count() > 2000 {
            let truncated: String = combined.chars().take(2000).collect();
            Some(format!(
                "{}...\n（用户画像已截断，完整信息请使用 memory_search 工具检索）",
                truncated
            ))
        } else {
            Some(combined)
        }
    }

    /// 加载活跃待办摘要（注入 system prompt）
    async fn load_active_todo_summary(&self) -> Option<String> {
        use crate::vfs::repos::VfsTodoRepo;

        let vfs_db = self.vfs_db.as_ref()?;
        match VfsTodoRepo::get_active_todo_summary(vfs_db) {
            Ok(Some(summary)) => {
                let formatted = VfsTodoRepo::format_active_summary_for_prompt(&summary);
                if formatted.is_empty() {
                    None
                } else {
                    log::debug!(
                        "[ChatV2::pipeline] Injecting active todo summary ({} today, {} overdue)",
                        summary.stats.today_due,
                        summary.stats.overdue_count
                    );
                    Some(formatted)
                }
            }
            Ok(None) => None,
            Err(e) => {
                log::warn!(
                    "[ChatV2::pipeline] Failed to load active todo summary: {}",
                    e
                );
                None
            }
        }
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
    /// - 使用 effective_max_history_messages（按 token 预算推导）粗筛消息条数
    /// - 提取所有 content 块并拼接（不只是第一个）
    /// - 提取 thinking 块内容
    /// - 提取 mcp_tool 块的工具调用信息
    /// - 解析 context_snapshot（如果有 vfs_db 连接）
    /// - 从附件中提取图片 base64 和文档附件
    fn load_source_user_canonical_for_assistant(
        &self,
        session_id: &str,
        assistant_message_id: &str,
    ) -> ChatV2Result<Option<Vec<crate::chat_v2::types::CanonicalContentPart>>> {
        let conn = self.db.get_conn_safe()?;
        let messages = ChatV2Repo::get_session_messages_with_conn(&conn, session_id)?;
        Ok(source_user_canonical_before_assistant(
            &messages,
            assistant_message_id,
        ))
    }

    async fn load_variant_chat_history(
        &self,
        session_id: &str,
        assistant_message_id: Option<&str>,
        // 🔧 P1-6：用于按 token 预算推导条数粗筛上限（对齐单变体 load_chat_history）
        context_limit: Option<u32>,
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

        let mut messages = ChatV2Repo::get_session_messages_with_conn(&conn, session_id)?;

        if messages.is_empty() {
            log::debug!(
                "[ChatV2::pipeline] No variant chat history found for session={}",
                session_id
            );
            return Ok(Vec::new());
        }

        if let Some(assistant_message_id) = assistant_message_id {
            if let Some(assistant_index) = messages
                .iter()
                .position(|message| message.id == assistant_message_id)
            {
                let source_user_id = messages[..assistant_index]
                    .iter()
                    .rev()
                    .find(|message| message.role == MessageRole::User)
                    .map(|message| message.id.clone());
                messages.retain(|message| {
                    message.id != assistant_message_id
                        && source_user_id
                            .as_ref()
                            .is_none_or(|user_id| message.id != *user_id)
                });
            }
        }

        // 🆕 P1: 应用 compaction 视图（与单变体路径一致）
        let (compaction_summary_msg, messages) =
            super::compaction::apply_compaction_view(&conn, session_id, messages);

        // 🔧 条数粗筛上限（对齐单变体）
        // 🔧 P1-6 修复：token 预算充裕时按预算放宽（50–400 条），精确裁剪由
        // 调用方的 trim_history_by_token_budget 按 token 完成
        let max_messages = effective_max_history_messages(context_limit);
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
        let active_variant_artifacts =
            super::history::active_variant_artifacts_by_user(&messages_to_load);

        log::debug!(
            "[ChatV2::pipeline] Loading {} variant messages (max_messages={})",
            messages_to_load.len(),
            max_messages
        );

        let mut chat_history = Vec::new();
        // 对齐主路径 load_chat_history：最近一条 user 消息在 chat_history 中的
        // 下标，workspace_injection 还原的 user 消息要插到这条消息之前
        let mut last_user_message_index: Option<usize> = None;
        for message in messages_to_load {
            let blocks = ChatV2Repo::get_message_blocks_with_conn(&conn, &message.id)?;
            // V20260806 B 层：重放旁路三列（无列/NULL 时空表，回退旧重建）
            let replay_map = ChatV2Repo::get_block_replay_map_with_conn(&conn, &message.id)?;
            // 🔧 ROUND-01-pipeline #1：只重放 active variant 的块
            let blocks = super::history::filter_blocks_for_active_variant(&message, blocks);

            // 🔧 对齐主路径：workspace_injection 块按 live 还原为 user 消息
            // （live 注入位置 = 上轮历史之后、本轮 user 消息之前）
            if message.role == MessageRole::Assistant {
                super::history::restore_workspace_injection_messages(
                    &blocks,
                    &mut chat_history,
                    &mut last_user_message_index,
                );
            }

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

            // V20260806 B 层：用户消息优先取 live 发送的完整包装（llm_content 列）
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
            let (content, vfs_image_base64) = if message.role == MessageRole::User {
                if let (Some(ref vfs_conn), Some(ref blobs_dir)) = (&vfs_conn_opt, &vfs_blobs_dir) {
                    let (resolved_content, images) = self.resolve_history_context_snapshot_v2(
                        &content, &message, vfs_conn, blobs_dir,
                    );
                    match llm_content_override {
                        Some(llm_content) => (llm_content, images),
                        None => (resolved_content, images),
                    }
                } else {
                    (llm_content_override.unwrap_or(content), Vec::new())
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
                    let replay = replay_map.get(tool_block.id.as_str());
                    // 🔧 对齐主路径：复用 history::build_tool_round_messages —
                    // tool_call_id / round_text / meta 回填（thought_signature、
                    // reasoning_content、Responses reasoning item）/ 检索脱敏
                    // 与单变体 load_chat_history 字节一致
                    let (assistant_tool_msg, tool_msg) = super::history::build_tool_round_messages(
                        message.meta.as_ref(),
                        replay,
                        tool_block,
                        None,
                    );
                    chat_history.push(assistant_tool_msg);
                    chat_history.push(tool_msg);

                    log::debug!(
                        "[ChatV2::pipeline] Loaded variant tool call from history: tool={}, block_id={}, index={}",
                        tool_block.tool_name.as_deref().unwrap_or_default(),
                        tool_block.id,
                        idx
                    );
                }
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

            if content.is_empty()
                && image_base64.is_none()
                && doc_attachments.is_none()
                && thinking_content
                    .as_ref()
                    .is_none_or(|thinking| thinking.trim().is_empty())
            {
                continue;
            }
            let content = if content.is_empty() && role == "user" {
                "[用户发送了附件]".to_string()
            } else {
                content
            };

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
                metadata: super::history::canonical_content_for_history(
                    &message,
                    active_variant_artifacts.get(&message.id),
                )
                .map(|parts| serde_json::json!({ "canonicalContent": parts })),
            };

            if role == "user" {
                last_user_message_index = Some(chat_history.len());
            }
            chat_history.push(legacy_message);
        }

        log::info!(
            "[ChatV2::pipeline] Loaded {} variant messages from history for session={}",
            chat_history.len(),
            session_id
        );

        // 🆕 验证工具调用链完整性
        // 🔧 P0-2 修复：破损时就地修复（合成占位结果/丢弃孤儿），不再只 warn 后照送 LLM
        if !validate_tool_chain(&chat_history) {
            repair_tool_chain(&mut chat_history);
        }

        // 🆕 P1: 如果有 compaction 摘要，插到最前面
        if let Some(summary_msg) = compaction_summary_msg {
            chat_history.insert(0, summary_msg);
        }

        Ok(chat_history)
    }

    /// 构建变体用户消息
    ///
    /// ★ 2026-03 修复：支持 user_context_refs 多模态内容注入
    /// 优先使用 user_context_refs 中的 formattedBlocks（与单变体路径 build_current_user_message 对齐），
    /// 回退到旧版 attachments 路径（兼容 retry 恢复场景）。
    /// ★ P1-10：`turn_volatile` 为 prompt_builder 拆分出的本轮动态块
    /// （共享检索/画像/待办/Canvas），编入 `<injected_context>` 而非 system。
    fn build_variant_user_message(
        &self,
        user_content: &str,
        attachments: &[AttachmentInput],
        user_context_refs: &[SendContextRef],
        turn_volatile: Option<&str>,
    ) -> LegacyChatMessage {
        let runtime_facts = PipelineContext::build_runtime_facts_block(user_content);

        // ★ 新路径：如果 user_context_refs 包含图片块，走多模态路径（与 prompt.rs 对齐）
        let has_context_images = user_context_refs.iter().any(|r| {
            r.formatted_blocks
                .iter()
                .any(|b| matches!(b, ContentBlock::Image { .. }))
        });

        if has_context_images {
            let ordered_blocks = PipelineContext::build_injected_context_blocks(
                &runtime_facts,
                user_context_refs,
                turn_volatile,
            );
            let (injected_text, _) =
                PipelineContext::collect_injected_context_text_and_images(&ordered_blocks);
            let combined =
                PipelineContext::wrap_user_message_text(user_content, Some(injected_text.as_str()));

            let mut blocks: Vec<ContentBlock> = Vec::new();

            if let Some(user_query) = PipelineContext::build_user_query_block(user_content) {
                blocks.push(ContentBlock::text(user_query));
            }

            if !ordered_blocks.is_empty() {
                blocks.push(ContentBlock::text("<injected_context>".to_string()));
                blocks.extend(ordered_blocks);
                blocks.push(ContentBlock::text("</injected_context>".to_string()));
            }

            let multimodal_parts: Vec<MultimodalContentPart> = blocks
                .into_iter()
                .map(|block| match block {
                    ContentBlock::Text { text } => MultimodalContentPart::text(text),
                    ContentBlock::Image { media_type, base64 } => {
                        MultimodalContentPart::image(media_type, base64)
                    }
                })
                .collect();

            log::info!(
                "[ChatV2::pipeline] build_variant_user_message: Using multimodal mode with {} parts from context refs",
                multimodal_parts.len()
            );

            return LegacyChatMessage {
                role: "user".to_string(),
                content: combined,
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
                multimodal_content: Some(multimodal_parts),
                tool_call: None,
                tool_result: None,
                overrides: None,
                relations: None,
                persistent_stable_id: None,
                metadata: None,
            };
        }

        let injected_blocks = PipelineContext::build_injected_context_blocks(
            &runtime_facts,
            user_context_refs,
            turn_volatile,
        );
        let (injected_text, _) =
            PipelineContext::collect_injected_context_text_and_images(&injected_blocks);
        let combined =
            PipelineContext::wrap_user_message_text(user_content, Some(injected_text.as_str()));

        log::info!(
            "[ChatV2::pipeline] build_variant_user_message: Using text mode with injected context, len={}",
            combined.len()
        );

        // ★ 回退路径：使用旧版 attachments（兼容 retry 恢复场景）
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
                    let text_content = if a.text_content.is_some() {
                        a.text_content.clone()
                    } else if let Some(ref base64) = a.base64_content {
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
            content: combined,
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
    pub(crate) async fn execute_variants_retry_batch(
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
        let emitter = Arc::new(
            super::super::events::ChatV2EventEmitter::new(window.clone(), session_id.clone())
                .with_stream_generation(options.stream_generation),
        );

        let shared_context_arc = Arc::new(shared_context);

        // 创建并行执行管理器（多变体重试）
        let manager = ParallelExecutionManager::with_cancel_token(cancel_token.clone());

        let mut variant_contexts: Vec<(
            Arc<VariantExecutionContext>,
            String,
            Option<crate::chat_v2::types::VariantMeta>,
        )> = Vec::with_capacity(variants.len());
        let mut variant_stream_guards = Vec::with_capacity(variants.len());

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
                let registration =
                    state.register_existing_token_owned(&cancel_key, ctx.cancel_token().clone());
                variant_stream_guards.push(super::super::state::StreamGuard::new(
                    Arc::clone(state),
                    cancel_key.clone(),
                    registration,
                ));
                log::debug!(
                    "[ChatV2::pipeline] Registered cancel token for retry variant: {}",
                    cancel_key
                );
            }

            variant_contexts.push((ctx, spec.config_id.clone(), spec.meta.clone()));
        }

        // 🔧 P1修复：并行执行所有变体（使用任务追踪器）
        let self_clone = self.clone();
        let options_arc = Arc::new(options.clone());
        let user_content_arc = Arc::new(user_content.clone());
        let session_id_arc = Arc::new(session_id.clone());
        let attachments_arc = Arc::new(user_attachments.clone());
        // P1 tools 前缀代际（方案 A）：重试批与主 fan-out 同构 —— spawn
        // 之前统一快照，join 之后收敛，变体内禁止中途写回共享态。
        let tool_face_baseline_arc = Arc::new(self.load_session_tool_face_prefix(&session_id));

        let futures: Vec<_> = variant_contexts
            .iter()
            .map(|(ctx, config_id, variant_meta)| {
                let self_ref = self_clone.clone();
                let ctx_clone = Arc::clone(ctx);
                let config_id_clone = config_id.clone();
                let variant_meta_clone = variant_meta.clone();
                let options_clone = Arc::clone(&options_arc);
                let user_content_clone = Arc::clone(&user_content_arc);
                let session_id_clone = Arc::clone(&session_id_arc);
                let attachments_clone = Arc::clone(&attachments_arc);
                let shared_ctx = Arc::clone(&shared_context_arc);
                let state_clone = chat_v2_state.clone();
                let tool_face_baseline_clone = Arc::clone(&tool_face_baseline_arc);

                let future = async move {
                    self_ref
                        .execute_single_variant_with_config(
                            ctx_clone,
                            config_id_clone,
                            variant_meta_clone,
                            (*options_clone).clone(),
                            (*user_content_clone).clone(),
                            (*session_id_clone).clone(),
                            shared_ctx,
                            (*attachments_clone).clone(),
                            Vec::new(),
                            tool_face_baseline_clone,
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
            let (ctx, _, _) = &variant_contexts[i];
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

        // P1 tools 前缀代际：重试批 join 之后按变体索引序收敛（与主
        // fan-out 同一收敛原语，快照含 order 与窗口 digest；单变体重试
        // = 纯扩展不切代由 converge 的前缀检查构造保证）。
        {
            let variant_local_prefixes: Vec<(
                usize,
                crate::chat_v2::types::ToolFacePrefixSnapshot,
            )> = variant_contexts
                .iter()
                .enumerate()
                .filter_map(|(variant_index, (ctx, _, _))| {
                    ctx.get_meta()
                        .and_then(|meta| meta.tool_face_prefix)
                        .map(|prefix| (variant_index, prefix))
                })
                .collect();
            if !variant_local_prefixes.is_empty() {
                self.converge_session_tool_face_prefix(&session_id, &variant_local_prefixes);
            }
        }

        // 持久化每个变体
        let mut update_error: Option<ChatV2Error> = None;
        for (ctx, _, _) in &variant_contexts {
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

        // Generation-owned guards clean up retry child keys without deleting a newer retry.
        drop(variant_stream_guards);

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
        let emitter = Arc::new(
            super::super::events::ChatV2EventEmitter::new(window.clone(), session_id.clone())
                .with_stream_generation(options.stream_generation),
        );

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

        // P1 tools 前缀代际（方案 A）：单变体重试同样入口统一快照、结束
        // 后收敛 —— 单变体输入对 converge 是纯前缀扩展，构造上永不切代。
        let tool_face_baseline_arc = Arc::new(self.load_session_tool_face_prefix(&session_id));

        // 执行变体（使用完整工具循环路径，与多变体主流程保持一致）
        // 注意：model_id（原始 config_id）传递给 execute_single_variant_with_config 用于 LLM 调用
        // retry 路径通过 user_attachments 传递图片（旧版兼容），context_refs 为空
        let result = self
            .execute_single_variant_with_config(
                ctx.clone(),
                model_id.clone(),
                None,
                options,
                user_content,
                session_id.clone(),
                shared_context_arc,
                user_attachments,
                Vec::new(),
                tool_face_baseline_arc,
            )
            .await;

        // P1 tools 前缀代际：变体环结束后收敛（禁止变体内中途 store）。
        // 快照整体传入：单变体输入构造上不切代，窗口 digest 经共识规则
        // 采纳（单变体本地 order 恒等于收敛结果，digest 直接生效）。
        if let Some(prefix) = ctx.get_meta().and_then(|meta| meta.tool_face_prefix) {
            self.converge_session_tool_face_prefix(&session_id, &[(0, prefix)]);
        }

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
                variant.meta = ctx.get_meta();
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

        if ctx.status() == variant_status::SUCCESS {
            if let Some(ref variants) = message.variants {
                if let Some(active_variant) = variants
                    .iter()
                    .find(|variant| variant.id == ctx.variant_id())
                {
                    if let Some(snapshot) = active_variant.meta.as_ref().and_then(|meta| {
                        meta.skill_snapshot_after
                            .as_ref()
                            .or(meta.skill_snapshot_before.as_ref())
                    }) {
                        let restored_base_state = crate::chat_v2::types::SessionSkillState {
                            manual_pinned_skill_ids: snapshot.manual_pinned_skill_ids.clone(),
                            mode_required_bundle_ids: snapshot.mode_required_bundle_ids.clone(),
                            agentic_session_skill_ids: snapshot.agentic_session_skill_ids.clone(),
                            branch_local_skill_ids: snapshot.branch_local_skill_ids.clone(),
                            effective_allowed_external_servers: snapshot
                                .effective_allowed_external_servers
                                .clone(),
                            version: snapshot.version,
                            legacy_migrated: Some(false),
                        }
                        .without_branch_local_skills();
                        let _ = ChatV2Repo::update_session_skill_state_v2(
                            &self.db,
                            &message.session_id,
                            &restored_base_state,
                        );
                    }
                }
            }
        }

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
        canonical_content: Vec<crate::chat_v2::types::CanonicalContentPart>,
        user_execution_snapshot: Option<crate::chat_v2::types::ModelExecutionSnapshot>,
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
                    // Variant artifacts remain variant-scoped. History compilation reads the
                    // currently active variant dynamically, so later switching cannot reuse a
                    // stale observation promoted by an earlier active selection.
                    .with_canonical_content(canonical_content.clone())
                    .with_execution_snapshot(user_execution_snapshot.clone())
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
                    .is_some_and(|v| !v.is_empty())
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
                    .is_some_and(|v| !v.is_empty())
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
                    .is_some_and(|v| !v.is_empty())
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
                    model_id: None,           // 多变体模式下不设置单一模型
                    execution_snapshot: None, // 每个 VariantMeta 持有独立快照
                    canonical_content: None,
                    chat_params: Some(json!({
                        "temperature": options.temperature,
                        "maxTokens": options.max_tokens,
                        "enableThinking": options.enable_thinking,
                        "reasoningEffort": options.reasoning_effort,
                        "thinkingBudget": options.thinking_budget,
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
                    skill_snapshot_before: None,
                    skill_snapshot_after: None,
                    skill_runtime_before: build_replay_skill_payload_snapshot(options),
                    skill_runtime_after: build_replay_skill_payload_snapshot(options),
                    replay_source: None,
                    response_reasoning_items: None,
                    skill_injection_anchors: None,
                    response_web_search_items: None,
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
                    log::warn!("[ChatV2::pipeline] Multi-variant save rolled back: {:?}", e);
                }
                Err(e)
            }
        }
    }
}

#[cfg(test)]
mod canonical_retry_tests {
    use super::*;
    use crate::chat_v2::types::{CanonicalContentPart, MessageMeta};

    fn message(
        id: &str,
        role: MessageRole,
        canonical_content: Option<Vec<CanonicalContentPart>>,
    ) -> ChatMessage {
        ChatMessage {
            id: id.to_string(),
            session_id: "session".to_string(),
            role,
            block_ids: Vec::new(),
            timestamp: 1,
            persistent_stable_id: None,
            parent_id: None,
            supersedes: None,
            meta: canonical_content.map(|canonical_content| MessageMeta {
                canonical_content: Some(canonical_content),
                ..Default::default()
            }),
            attachments: None,
            active_variant_id: None,
            variants: None,
            shared_context: None,
        }
    }

    #[test]
    fn retry_without_context_refs_recovers_original_blob_canonical() {
        let original = vec![
            CanonicalContentPart::Text {
                text: "inspect this".to_string(),
            },
            CanonicalContentPart::ImageRef {
                image_id: "img-1".to_string(),
                name: Some("photo.jpg".to_string()),
                resource_id: Some("res-1".to_string()),
                source_id: Some("source-1".to_string()),
                blob_hash: Some("stable-original-blob".to_string()),
                content_hash: None,
                mime_type: "image/jpeg".to_string(),
                pinned: false,
                retrieval_hit: false,
            },
        ];
        let messages = vec![
            message("user", MessageRole::User, Some(original.clone())),
            message("assistant", MessageRole::Assistant, None),
        ];

        assert_eq!(
            source_user_canonical_before_assistant(&messages, "assistant"),
            Some(original)
        );
    }
}

// ============================================================
// multi_variant 历史重建回放一致性测试
// （对齐主路径 load_chat_history：检索脱敏 / reasoning item 回填 /
//  thought_signature / workspace_injection 还原）
// ============================================================

#[cfg(test)]
mod variant_replay_tests {
    use super::*;
    use crate::chat_v2::pipeline::history::replay_test_support::*;
    use crate::chat_v2::repo::BlockReplayData;
    use crate::chat_v2::types::{ChatSession, MessageMeta};
    use std::collections::HashMap;

    /// 变体路径回放缺口回归：workspace_injection 还原为 user 消息插到该轮
    /// user 之前；工具轮 thought_signature / reasoning_content / Responses
    /// reasoning item 经 meta 回填；成功检索工具输出走同一份 LLM 视图脱敏。
    /// 全部与 live 的 `all_tool_results_to_messages` 形态字节对齐。
    #[tokio::test]
    async fn variant_replay_aligns_with_live_tool_round_bytes() {
        let (_dir, pipeline) = replay_test_pipeline();
        let conn = pipeline.db.get_conn_safe().unwrap();
        let session_id = "sess_variant_replay";
        ChatV2Repo::create_session_with_conn(
            &conn,
            &ChatSession::new(session_id.to_string(), "chat".to_string()),
        )
        .unwrap();

        // ---- 上一轮用户消息：llm_content 列存 live 完整包装 ----
        insert_user_turn(&conn, session_id, "msg_mv_u1", "blk_mv_u1", "查资料", 1_000);
        let live_user_content = "<user_query>\n查资料\n</user_query>";
        ChatV2Repo::update_block_replay_with_conn(
            &conn,
            "blk_mv_u1",
            &BlockReplayData {
                llm_content: Some(live_user_content.to_string()),
                ..Default::default()
            },
        )
        .unwrap();

        // ---- 上一轮助手消息：workspace_injection + 检索工具 + 正文 ----
        // 检索输出带本地路径/诊断字段，回放必须走 sanitize（禁止 to_string 裸回灌）
        let raw_tool_output = serde_json::json!({
            "sources": [{
                "title": "资料 A",
                "imageUrl": "/local/blobs/a.png",
                "blob_hash": "hash-a",
                "url": "file:///local/a.md",
                "content": "正文片段"
            }],
            "retrievalPlan": { "steps": 2 }
        });
        let reasoning_item = serde_json::json!({"type": "reasoning", "id": "rs_mv_1"});
        let live_tool_result = ToolResultInfo {
            tool_call_id: Some("call_mv_1".to_string()),
            block_id: Some("blk_mv_tool".to_string()),
            tool_name: "builtin-rag_search".to_string(),
            input: serde_json::json!({"query": "资料"}),
            output: raw_tool_output.clone(),
            success: true,
            error: None,
            duration_ms: Some(7),
            reasoning_content: Some("先检索资料".to_string()),
            thought_signature: Some("sig-mv-1".to_string()),
        };
        let mut assistant_msg = ChatMessage::new_assistant(session_id.to_string());
        assistant_msg.id = "msg_mv_a1".to_string();
        assistant_msg.timestamp = 2_000;
        assistant_msg.block_ids = vec![
            "blk_mv_inject".to_string(),
            "blk_mv_tool".to_string(),
            "blk_mv_c1".to_string(),
        ];
        assistant_msg.meta = Some(MessageMeta {
            tool_results: Some(vec![live_tool_result.clone()]),
            response_reasoning_items: Some(HashMap::from([(
                "call_mv_1".to_string(),
                reasoning_item.clone(),
            )])),
            ..Default::default()
        });
        ChatV2Repo::create_message_with_conn(&conn, &assistant_msg).unwrap();

        let mut injection_block =
            MessageBlock::new("msg_mv_a1".to_string(), block_types::WORKSPACE_INJECTION, 0);
        injection_block.id = "blk_mv_inject".to_string();
        injection_block.status = block_status::SUCCESS.to_string();
        injection_block.content = Some("[来自工作区] 主代理插话：先查 A".to_string());
        injection_block.tool_output = Some(serde_json::json!({
            "workspace_id": "ws_mv_1",
            "message_count": 1,
        }));
        ChatV2Repo::create_block_with_conn(&conn, &injection_block).unwrap();

        let mut tool_block = MessageBlock::new_tool(
            "msg_mv_a1".to_string(),
            "builtin-rag_search",
            live_tool_result.input.clone(),
            1,
        );
        tool_block.id = "blk_mv_tool".to_string();
        tool_block.status = block_status::SUCCESS.to_string();
        tool_block.tool_output = Some(raw_tool_output.clone());
        ChatV2Repo::create_block_with_conn(&conn, &tool_block).unwrap();
        ChatV2Repo::update_block_replay_with_conn(
            &conn,
            "blk_mv_tool",
            &BlockReplayData {
                llm_content: None,
                tool_call_id: Some("call_mv_1".to_string()),
                round_text: Some("我先检索资料。".to_string()),
            },
        )
        .unwrap();

        let mut content = MessageBlock::new_content("msg_mv_a1".to_string(), 2);
        content.id = "blk_mv_c1".to_string();
        content.content = Some("根据资料……".to_string());
        content.status = block_status::SUCCESS.to_string();
        ChatV2Repo::create_block_with_conn(&conn, &content).unwrap();

        // ---- 本轮（变体重生成目标）：user + assistant 会被排除 ----
        insert_user_turn(
            &conn,
            session_id,
            "msg_mv_u2",
            "blk_mv_u2",
            "再来一次",
            3_000,
        );
        let mut variant_assistant = ChatMessage::new_assistant(session_id.to_string());
        variant_assistant.id = "msg_mv_a2".to_string();
        variant_assistant.timestamp = 4_000;
        ChatV2Repo::create_message_with_conn(&conn, &variant_assistant).unwrap();
        drop(conn);

        // ---- 变体路径重放 ----
        let history = pipeline
            .load_variant_chat_history(session_id, Some("msg_mv_a2"), None)
            .await
            .unwrap();
        assert_eq!(
            history.len(),
            5,
            "injection + user + tool_call + tool + final"
        );

        // 1) workspace_injection 还原为 user 消息，插在该轮 user 之前
        assert_eq!(history[0].role, "user");
        assert_eq!(history[0].content, "[来自工作区] 主代理插话：先查 A");
        let injection_meta = history[0].metadata.as_ref().unwrap();
        assert_eq!(
            injection_meta.get("workspace_injection"),
            Some(&serde_json::Value::Bool(true))
        );
        assert_eq!(
            injection_meta.get("workspace_id"),
            Some(&serde_json::json!("ws_mv_1"))
        );
        assert_eq!(history[1].role, "user");
        assert_eq!(history[1].content, live_user_content);

        // 2) 工具轮与 live 形态字节对齐（同一数据走 live 的
        //    all_tool_results_to_messages 构建作为基准）
        let mut live_ctx = next_turn_ctx(session_id);
        live_ctx.tool_results = vec![live_tool_result];
        live_ctx
            .round_text_by_tool_call_id
            .insert("call_mv_1".to_string(), "我先检索资料。".to_string());
        live_ctx
            .response_reasoning_by_tool_call_id
            .insert("call_mv_1".to_string(), reasoning_item.clone());
        let live_msgs = live_ctx.all_tool_results_to_messages();
        assert_eq!(live_msgs.len(), 2);

        let replayed_call = &history[2];
        let live_call = &live_msgs[0];
        assert_eq!(replayed_call.role, live_call.role);
        assert_eq!(replayed_call.content, live_call.content);
        assert_eq!(replayed_call.thinking_content, live_call.thinking_content);
        assert_eq!(
            replayed_call.thought_signature, live_call.thought_signature,
            "thought_signature 必须经 meta.tool_results 回填，禁止恒 None"
        );
        assert_eq!(
            replayed_call.thought_signature,
            Some("sig-mv-1".to_string())
        );
        assert_eq!(
            replayed_call.metadata, live_call.metadata,
            "Responses reasoning item 必须回填到出站 metadata"
        );
        assert_eq!(
            replayed_call
                .metadata
                .as_ref()
                .and_then(|m| m.get("openai_responses_reasoning_item")),
            Some(&reasoning_item)
        );
        assert_eq!(
            replayed_call.tool_call.as_ref().unwrap().id,
            "call_mv_1",
            "禁止 tc_{{block_id}} 派生"
        );

        // 3) 成功检索工具输出走 LLM 视图脱敏（与 live 字节一致），
        //    禁止 to_string 裸回灌本地路径/诊断字段
        let replayed_tool = &history[3];
        let live_tool = &live_msgs[1];
        assert_eq!(replayed_tool.role, live_tool.role);
        assert_eq!(replayed_tool.content, live_tool.content);
        assert_ne!(
            replayed_tool.content,
            serde_json::to_string(&raw_tool_output).unwrap(),
            "回放的 tool 消息不得等于未脱敏的原始 output"
        );
        assert!(!replayed_tool.content.contains("imageUrl"));
        assert!(!replayed_tool.content.contains("retrievalPlan"));
        assert!(!replayed_tool.content.contains("file:///local/a.md"));
        // 持久化视图（data_json）保持原始 output 完整
        assert_eq!(
            replayed_tool.tool_result.as_ref().unwrap().data_json,
            Some(raw_tool_output)
        );

        // 4) 末尾正文
        assert_eq!(history[4].role, "assistant");
        assert_eq!(history[4].content, "根据资料……");
    }

    /// 回退回归：旁路三列为 NULL 且 meta 缺失（老数据）时，变体路径保持
    /// 旧重建（tc_{block_id} 派生 / 空 round_text / 无签名与 reasoning item），
    /// 不 panic 不丢消息
    #[tokio::test]
    async fn variant_replay_falls_back_without_sidecar_and_meta() {
        let (_dir, pipeline) = replay_test_pipeline();
        let conn = pipeline.db.get_conn_safe().unwrap();
        let session_id = "sess_variant_fallback";
        ChatV2Repo::create_session_with_conn(
            &conn,
            &ChatSession::new(session_id.to_string(), "chat".to_string()),
        )
        .unwrap();

        insert_user_turn(&conn, session_id, "msg_mf_u1", "blk_mf_u1", "老问题", 1_000);

        let mut assistant_msg = ChatMessage::new_assistant(session_id.to_string());
        assistant_msg.id = "msg_mf_a1".to_string();
        assistant_msg.timestamp = 2_000;
        assistant_msg.block_ids = vec!["blk_mf_tool".to_string(), "blk_mf_c1".to_string()];
        ChatV2Repo::create_message_with_conn(&conn, &assistant_msg).unwrap();

        let mut tool_block = MessageBlock::new_tool(
            "msg_mf_a1".to_string(),
            "builtin-note_read",
            serde_json::json!({"id": "n1"}),
            0,
        );
        tool_block.id = "blk_mf_tool".to_string();
        tool_block.status = block_status::SUCCESS.to_string();
        tool_block.tool_output = Some(serde_json::json!({"ok": true}));
        ChatV2Repo::create_block_with_conn(&conn, &tool_block).unwrap();

        let mut content = MessageBlock::new_content("msg_mf_a1".to_string(), 1);
        content.id = "blk_mf_c1".to_string();
        content.content = Some("老回答".to_string());
        content.status = block_status::SUCCESS.to_string();
        ChatV2Repo::create_block_with_conn(&conn, &content).unwrap();

        insert_user_turn(&conn, session_id, "msg_mf_u2", "blk_mf_u2", "重试", 3_000);
        let mut variant_assistant = ChatMessage::new_assistant(session_id.to_string());
        variant_assistant.id = "msg_mf_a2".to_string();
        variant_assistant.timestamp = 4_000;
        ChatV2Repo::create_message_with_conn(&conn, &variant_assistant).unwrap();
        drop(conn);

        let history = pipeline
            .load_variant_chat_history(session_id, Some("msg_mf_a2"), None)
            .await
            .unwrap();
        assert_eq!(history.len(), 4, "user + tool_call + tool + final");
        assert_eq!(history[0].content, "老问题");
        let tool_call_msg = &history[1];
        assert_eq!(tool_call_msg.tool_call.as_ref().unwrap().id, "tc_mf_tool");
        assert_eq!(tool_call_msg.content, "");
        assert_eq!(tool_call_msg.thought_signature, None);
        assert!(tool_call_msg.metadata.is_none());
        assert_eq!(
            history[2].tool_result.as_ref().unwrap().call_id,
            "tc_mf_tool"
        );
        assert_eq!(history[3].content, "老回答");
    }
}
