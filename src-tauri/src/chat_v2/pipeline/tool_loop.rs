use super::*;

#[derive(Debug, Clone)]
pub(crate) struct ExternalToolRoute {
    pub raw_tool_name: String,
    pub preferred_server_id: Option<String>,
}

impl ChatV2Pipeline {
    /// 执行 LLM 调用（支持工具递归）
    ///
    /// ## 工具递归流程
    /// 1. 调用 LLM 获取响应
    /// 2. 如果响应包含工具调用，执行工具
    /// 3. 将工具结果添加到聊天历史
    /// 4. 递归调用直到无工具调用或达到最大深度
    ///
    /// ## 参数
    /// - `ctx`: 流水线上下文（可变，用于存储工具结果）
    /// - `emitter`: 事件发射器
    /// - `system_prompt`: 系统提示
    /// - `recursion_depth`: 当前递归深度
    ///
    /// ## 错误
    /// - 超过最大递归深度 (MAX_TOOL_RECURSION = 5)
    /// - LLM 调用失败
    pub(crate) async fn execute_with_tools(
        &self,
        ctx: &mut PipelineContext,
        emitter: Arc<ChatV2EventEmitter>,
        system_prompt: &str,
        recursion_depth: u32,
    ) -> ChatV2Result<()> {
        // 检查递归深度限制
        // 🔧 配置化：使用用户设置的限制值，默认 MAX_TOOL_RECURSION (30)
        let max_recursion = ctx
            .options
            .max_tool_recursion
            .unwrap_or(MAX_TOOL_RECURSION)
            .clamp(1, 100); // 限制范围 1-100

        // 🔒 安全修复：心跳机制仅信任白名单内部工具
        // 外部/MCP 工具不能通过返回 continue_execution 绕过递归限制
        const ABSOLUTE_MAX_RECURSION: u32 = 150;
        const MAX_HEARTBEAT_COUNT: u32 = 50;
        const HEARTBEAT_TOOLS: &[&str] = &["coordinator_sleep", "builtin-coordinator_sleep"];

        let has_heartbeat = ctx.tool_results.iter().any(|r| {
            HEARTBEAT_TOOLS.contains(&r.tool_name.as_str())
                && r.output
                    .get("continue_execution")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
        });

        // 追踪连续心跳次数，超过上限后忽略心跳
        if has_heartbeat {
            ctx.heartbeat_count += 1;
            if ctx.heartbeat_count > MAX_HEARTBEAT_COUNT {
                log::warn!(
                    "[ChatV2::pipeline] Heartbeat count exceeded limit: count={}, max={}, ignoring heartbeat",
                    ctx.heartbeat_count,
                    MAX_HEARTBEAT_COUNT
                );
            }
        } else {
            ctx.heartbeat_count = 0;
        }

        let heartbeat_effective = has_heartbeat && ctx.heartbeat_count <= MAX_HEARTBEAT_COUNT;

        // 绝对上限检查（不可绕过）
        if recursion_depth > ABSOLUTE_MAX_RECURSION {
            log::error!(
                "[ChatV2::pipeline] ABSOLUTE recursion limit reached: depth={}, absolute_max={}",
                recursion_depth,
                ABSOLUTE_MAX_RECURSION
            );
            return Err(ChatV2Error::Tool(format!(
                "达到绝对递归上限 ({})，任务已终止",
                ABSOLUTE_MAX_RECURSION
            )));
        }

        // 普通限制检查（仅白名单工具的有效心跳可绕过）
        if recursion_depth > max_recursion && !heartbeat_effective {
            log::warn!(
                "[ChatV2::pipeline] Tool recursion limit reached: depth={}, max={}",
                recursion_depth,
                max_recursion
            );

            // 创建 tool_limit 块，提示用户达到限制
            let block_id = MessageBlock::generate_id();
            let now_ms = chrono::Utc::now().timestamp_millis();
            let limit_message = format!(
                "⚠️ 已达到工具调用限制（{} 轮）\n\n\
                AI 已执行了 {} 轮工具调用。为防止无限循环，已暂停自动执行。\n\n\
                如果任务尚未完成，您可以：\n\
                • 发送「继续」让 AI 继续执行\n\
                • 发送新的指令调整方向\n\
                • 手动完成剩余步骤",
                max_recursion, max_recursion
            );

            // 发送 start 事件
            emitter.emit_start(
                event_types::TOOL_LIMIT,
                &ctx.assistant_message_id,
                Some(&block_id),
                None,
                None,
            );

            // 发送 end 事件，携带提示内容
            let result_payload = serde_json::json!({
                "content": limit_message,
                "recursionDepth": recursion_depth,
                "maxRecursion": max_recursion,
            });
            emitter.emit_end(
                event_types::TOOL_LIMIT,
                &block_id,
                Some(result_payload),
                None,
            );

            // 创建块并添加到 interleaved 列表
            let tool_limit_block = MessageBlock {
                id: block_id.clone(),
                message_id: ctx.assistant_message_id.clone(),
                block_type: block_types::TOOL_LIMIT.to_string(),
                status: block_status::SUCCESS.to_string(),
                content: Some(limit_message),
                tool_name: None,
                tool_input: None,
                tool_output: None,
                citations: None,
                error: None,
                started_at: Some(now_ms),
                ended_at: Some(now_ms),
                first_chunk_at: Some(now_ms),
                block_index: 0, // 会被 add_interleaved_block 覆盖
            };
            ctx.add_interleaved_block(tool_limit_block);

            log::info!(
                "[ChatV2::pipeline] Created tool_limit block: id={}, message_id={}",
                block_id,
                ctx.assistant_message_id
            );

            // 正常返回，不抛出错误
            return Ok(());
        }

        log::info!(
            "[ChatV2::pipeline] Executing LLM call: session={}, recursion_depth={}, tool_results={}",
            ctx.session_id,
            recursion_depth,
            ctx.tool_results.len()
        );

        // 创建 LLM 适配器
        // 🔧 修复：默认启用 thinking，确保思维链内容能正确累积和保存
        let enable_thinking = ctx.options.enable_thinking.unwrap_or(true);
        log::info!(
            "[ChatV2::pipeline] enable_thinking={} (from options: {:?})",
            enable_thinking,
            ctx.options.enable_thinking
        );
        let adapter = Arc::new(ChatV2LLMAdapter::new(
            emitter.clone(),
            ctx.assistant_message_id.clone(),
            enable_thinking,
            ctx.options.skill_state_version,
            Some(format!("tool-round-{}", recursion_depth)),
        ));

        // 🔧 修复：存储 adapter 引用到 ctx，确保取消时可以获取已累积内容
        ctx.current_adapter = Some(adapter.clone());

        // ============================================================
        // 构建聊天历史（包含之前的工具结果 + 当前用户消息）
        // ============================================================
        let mut messages = ctx.chat_history.clone();

        // 🔴 关键修复：添加当前用户消息到消息列表
        // 之前这里缺失，导致 LLM 看不到用户当前发送的问题
        let current_user_message = self.build_current_user_message(ctx);
        messages.push(current_user_message);
        log::debug!(
            "[ChatV2::pipeline] Added current user message: content_len={}, has_images={}, has_docs={}",
            ctx.user_content.len(),
            ctx.attachments.iter().any(|a| a.mime_type.starts_with("image/")),
            ctx.attachments.iter().any(|a| !a.mime_type.starts_with("image/"))
        );

        // 如果有工具结果（递归调用时），将**所有**工具结果添加到消息历史
        // 🔧 关键修复：由于 messages 每次从 chat_history.clone() 重建，
        // 之前只添加"新"工具结果会导致历史丢失。现在改为每次添加所有工具结果，
        // 确保 LLM 能看到完整的工具调用历史（符合 Anthropic 最佳实践：
        // "Messages API 是无状态的，必须每次发送完整对话历史"）
        if !ctx.tool_results.is_empty() {
            let tool_messages = ctx.all_tool_results_to_messages();
            let tool_count = tool_messages.len();
            messages.extend(tool_messages);

            log::debug!(
                "[ChatV2::pipeline] Added ALL {} tool result messages to chat history (tool_results count: {})",
                tool_count,
                ctx.tool_results.len()
            );
        }

        // ============================================================
        // 调用 LLM
        // ============================================================
        // 构建 LLM 调用上下文
        let mut llm_context: HashMap<String, Value> = HashMap::new();

        // 注入检索到的来源到上下文
        if let Some(ref rag_sources) = ctx.retrieved_sources.rag {
            llm_context.insert(
                "prefetched_rag_sources".into(),
                serde_json::to_value(rag_sources).unwrap_or(Value::Null),
            );
        }
        if let Some(ref memory_sources) = ctx.retrieved_sources.memory {
            llm_context.insert(
                "prefetched_memory_sources".into(),
                serde_json::to_value(memory_sources).unwrap_or(Value::Null),
            );
        }
        if let Some(ref web_sources) = ctx.retrieved_sources.web_search {
            llm_context.insert(
                "prefetched_web_search_sources".into(),
                serde_json::to_value(web_sources).unwrap_or(Value::Null),
            );
        }
        llm_context.insert(
            "memory_enabled".into(),
            Value::Bool(ctx.options.memory_enabled.unwrap_or(true)),
        );
        llm_context.insert(
            "rag_enabled".into(),
            Value::Bool(ctx.options.rag_enabled.unwrap_or(true)),
        );
        llm_context.insert(
            "web_search_enabled".into(),
            Value::Bool(ctx.options.web_search_enabled.unwrap_or(true)),
        );

        // ====================================================================
        // 🆕 图片压缩策略：vision_quality 智能默认
        // ====================================================================
        // 策略逻辑：
        // 1. 用户显式指定 → 直接使用
        // 2. auto/空 → 根据图片数量和来源自动选择：
        //    - 单图 + 非 PDF：high（保持原质量，便于 OCR）
        //    - 2-5 张图：medium
        //    - 6+ 张图或 PDF/教材：low（最大压缩，节省 token）
        let vision_quality = {
            // 检查用户是否显式指定
            let user_specified = ctx
                .options
                .vision_quality
                .as_deref()
                .filter(|v| !v.is_empty() && *v != "auto");

            if let Some(vq) = user_specified {
                // 用户显式指定
                log::debug!("[ChatV2::pipeline] vision_quality: user specified '{}'", vq);
                vq.to_string()
            } else {
                // 自动策略：统计图片数量和 PDF/教材来源
                let mut image_count = 0usize;
                let mut has_pdf_or_textbook = false;

                for ctx_ref in &ctx.user_context_refs {
                    // 统计图片块数量
                    for block in &ctx_ref.formatted_blocks {
                        if matches!(
                            block,
                            super::super::resource_types::ContentBlock::Image { .. }
                        ) {
                            image_count += 1;
                        }
                    }
                    // 检查是否有 PDF/教材来源（通过 type_id 判断）
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
                    "[ChatV2::pipeline] vision_quality: auto -> '{}' (images={}, has_pdf_or_textbook={})",
                    auto_quality, image_count, has_pdf_or_textbook
                );
                auto_quality.to_string()
            }
        };

        // 注入到 LLM 上下文
        llm_context.insert(
            "vision_quality".into(),
            Value::String(vision_quality.clone()),
        );

        // ====================================================================
        // 统一工具注入：使用 schema_tool_ids 注入工具 Schema
        // 遵循文档 26：统一工具注入系统架构设计
        // 🆕 文档 29 P1-4：自动注入 attempt_completion 工具（Agent 模式必备）
        // ====================================================================

        // 构建工具列表，自动添加 Agent 必备工具（如果有其他工具被注入）
        // 注意：内置工具（包括 TodoList）应该通过内置 MCP 服务器注入，不在此处添加
        let effective_tool_ids: Option<Vec<String>> = match ctx.options.schema_tool_ids.as_ref() {
            Some(ids) if !ids.is_empty() => {
                let mut extended_ids = ids.clone();

                // 🆕 自动添加 attempt_completion 到工具列表（如果尚未包含）
                // 这是唯一需要在此添加的工具，因为它是 Agent 模式的终止信号
                if !extended_ids
                    .iter()
                    .any(|id| id == super::super::tools::attempt_completion::TOOL_NAME)
                {
                    extended_ids
                        .push(super::super::tools::attempt_completion::TOOL_NAME.to_string());
                    log::debug!(
                        "[ChatV2::pipeline] Auto-injected attempt_completion tool (Agent mode)"
                    );
                }

                Some(extended_ids)
            }
            _ => None,
        };

        let injected_count = super::super::tools::injector::inject_tool_schemas(
            effective_tool_ids.as_ref(),
            &mut llm_context,
        );
        if injected_count > 0 {
            log::info!(
                "[ChatV2::pipeline] Injected {} tool schemas via schema_tool_ids",
                injected_count
            );
        }

        // ====================================================================
        // 🆕 Workspace 工具注入：已迁移到内置 MCP 服务器
        // ====================================================================
        // 2026-01-16: Workspace 工具已迁移到 builtinMcpServer.ts，
        // 通过前端 mcp_tool_schemas 传递，不再需要后端自动注入。
        // 执行器 WorkspaceToolExecutor 仍然保留，负责处理 builtin-workspace_* 工具调用。
        //
        // 旧代码已移除：后端自动注入会导致工具重复（builtin-workspace_create vs workspace_create）
        if ctx.get_workspace_id().is_some() && self.workspace_coordinator.is_some() {
            log::debug!(
                "[ChatV2::pipeline] Workspace session detected, tools should come from builtin MCP server"
            );
        }

        // ====================================================================
        // 🆕 MCP 工具注入：使用前端传递的 mcp_tool_schemas
        // ====================================================================
        // 架构说明：
        // - 前端 mcpService 管理多 MCP 服务器连接，并缓存工具 Schema
        // - 前端 TauriAdapter 从 mcpService 获取选中服务器的工具 Schema
        // - 后端直接使用前端传递的 Schema，无需自己连接 MCP 服务器
        // - 🔧 P1-49：后端应用 whitelist/blacklist 策略过滤，确保配置生效

        // 🔧 工具名称映射：sanitized API name → original name（含 `:` 等特殊字符）
        // 用于 LLM 返回工具调用时反向映射回原始名称
        let mut mcp_tool_name_mapping: HashMap<String, ExternalToolRoute> = HashMap::new();

        // 🔍 调试日志：检查 mcp_tool_schemas 在 pipeline 中的状态
        let mcp_schema_count = ctx
            .options
            .mcp_tool_schemas
            .as_ref()
            .map(|s| s.len())
            .unwrap_or(0);
        log::info!(
            "[ChatV2::pipeline] 🔍 MCP tool schemas check: count={}, is_some={}",
            mcp_schema_count,
            ctx.options.mcp_tool_schemas.is_some()
        );

        if let Some(ref tool_schemas) = ctx.options.mcp_tool_schemas {
            if !tool_schemas.is_empty() {
                log::info!(
                    "[ChatV2::pipeline] Processing {} MCP tool schemas from frontend",
                    tool_schemas.len()
                );

                // 🔧 P1-49: 读取 MCP 策略配置（whitelist/blacklist）
                let (whitelist, blacklist) = if let Some(ref main_db) = self.main_db {
                    let whitelist: Vec<String> = main_db
                        .get_setting("mcp.tools.whitelist")
                        .ok()
                        .flatten()
                        .map(|s| {
                            s.split(',')
                                .map(|x| x.trim().to_string())
                                .filter(|x| !x.is_empty())
                                .collect()
                        })
                        .unwrap_or_default();
                    let blacklist: Vec<String> = main_db
                        .get_setting("mcp.tools.blacklist")
                        .ok()
                        .flatten()
                        .map(|s| {
                            s.split(',')
                                .map(|x| x.trim().to_string())
                                .filter(|x| !x.is_empty())
                                .collect()
                        })
                        .unwrap_or_default();
                    (whitelist, blacklist)
                } else {
                    (Vec::new(), Vec::new())
                };

                log::debug!(
                    "[ChatV2::pipeline] MCP policy: whitelist={:?}, blacklist={:?}",
                    whitelist,
                    blacklist
                );

                // 将前端传递的 MCP 工具 Schema 转换为 LLM 可用的格式
                // 🔧 P1-49: 应用 whitelist/blacklist 过滤
                let mcp_tool_values: Vec<Value> = tool_schemas
                    .iter()
                    .filter(|tool| {
                        // builtin- 前缀的工具不受策略过滤影响
                        if tool.name.starts_with(BUILTIN_NAMESPACE) {
                            return true;
                        }
                        // 黑名单优先级最高
                        if !blacklist.is_empty() && blacklist.iter().any(|b| b == &tool.name) {
                            log::debug!(
                                "[ChatV2::pipeline] Tool '{}' blocked by blacklist",
                                tool.name
                            );
                            return false;
                        }
                        // 如果白名单非空，工具必须在白名单中
                        if !whitelist.is_empty() && !whitelist.iter().any(|w| w == &tool.name) {
                            log::debug!("[ChatV2::pipeline] Tool '{}' not in whitelist", tool.name);
                            return false;
                        }
                        true
                    })
                    .map(|tool| {
                        // 🔧 P0-19 修复：builtin- 前缀的工具保持原名，MCP 工具添加 mcp_ 前缀
                        // 原因：executor 检查 tool_name.starts_with("builtin-")，
                        //       如果变成 "mcp_builtin-..." 则无法匹配
                        let raw_tool_name = if tool.name.starts_with(BUILTIN_NAMESPACE) {
                            tool.name.clone()
                        } else {
                            format!("mcp_{}", tool.name)
                        };
                        // 🔧 修复：OpenAI API 要求 function name 匹配 ^[a-zA-Z0-9_-]+$
                        // MCP 工具名可能含 `:` 等特殊字符（如 namespace 分隔符）
                        let mut api_tool_name = sanitize_tool_name_for_api(&raw_tool_name);
                        if let Some(server_id) = tool.server_id.as_deref() {
                            let candidate = format!(
                                "{}__srv_{}",
                                api_tool_name,
                                sanitize_tool_name_for_api(server_id)
                            );
                            api_tool_name = candidate;
                        }
                        mcp_tool_name_mapping.insert(
                            api_tool_name.clone(),
                            ExternalToolRoute {
                                raw_tool_name,
                                preferred_server_id: tool.server_id.clone(),
                            },
                        );
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

                let filtered_count = mcp_tool_values.len();
                let original_count = tool_schemas.len();
                if filtered_count < original_count {
                    log::info!(
                        "[ChatV2::pipeline] MCP policy filtered: {}/{} tools allowed",
                        filtered_count,
                        original_count
                    );
                }

                // 合并到 custom_tools（如果已存在则追加）
                if !mcp_tool_values.is_empty() {
                    if let Some(existing) = llm_context.get_mut("custom_tools") {
                        if let Some(arr) = existing.as_array_mut() {
                            for schema in mcp_tool_values {
                                arr.push(schema);
                            }
                            log::info!(
                                "[ChatV2::pipeline] Appended {} MCP tools to custom_tools",
                                filtered_count
                            );
                        }
                    } else {
                        llm_context.insert("custom_tools".into(), Value::Array(mcp_tool_values));
                        log::info!(
                            "[ChatV2::pipeline] Injected {} MCP tools as custom_tools",
                            filtered_count
                        );
                    }
                }

                // 记录工具名称用于调试
                let tool_names: Vec<&str> = tool_schemas.iter().map(|t| t.name.as_str()).collect();
                log::debug!(
                    "[ChatV2::pipeline] MCP tools (before filter): {:?}",
                    tool_names
                );
            }
        }

        // 生成流事件标识符
        let stream_event = format!("chat_v2_event_{}", ctx.session_id);

        // 注册 LLM 流式回调 hooks
        self.llm_manager
            .register_stream_hooks(&stream_event, adapter.clone())
            .await;

        // 获取调用选项
        // 🔧 P0修复：始终禁用 LLM Manager 内部的工具执行，由 Pipeline 完全接管
        // 这避免了工具被执行两次（LLM Manager 内部一次，Pipeline 一次）
        // 以及工具调用 start 事件被重复发射的问题
        let disable_tools = true;
        // 🔧 P0修复：优先使用 model2_override_id（ModelPanel 中选择的模型），其次使用 model_id
        let model_override = ctx
            .options
            .model2_override_id
            .clone()
            .or_else(|| ctx.options.model_id.clone());
        let temp_override = ctx.options.temperature;
        let top_p_override = ctx.options.top_p;
        let frequency_penalty_override = ctx.options.frequency_penalty;
        let presence_penalty_override = ctx.options.presence_penalty;
        let max_tokens_override = ctx.options.max_tokens;
        // 🔧 P1修复：将 context_limit 作为 max_input_tokens_override 传递给 LLM
        let max_input_tokens_override = ctx.options.context_limit.map(|v| v as usize);
        // 🔧 P2修复：始终使用 prompt_builder 生成的 system_prompt（XML 格式）
        // prompt_builder 已经将前端传入的 system_prompt_override 作为 base_prompt 处理
        // 不再让前端的值直接覆盖，避免丢失 LaTeX 规则等 XML 格式内容
        let system_prompt_override = Some(system_prompt.to_string());

        // 获取 window 用于流式事件发射
        let window = emitter.window();

        log::info!(
            "[ChatV2::pipeline] Calling LLMManager, stream_event={}, model_override={:?}, top_p={:?}, max_tokens={:?}, max_input_tokens={:?}",
            stream_event,
            model_override,
            top_p_override,
            max_tokens_override,
            max_input_tokens_override
        );

        // 调用 LLMManager 的流式接口
        // 🔧 P1修复：添加 Pipeline 层超时保护，不完全依赖上游 LLM 配置
        let llm_future = self.llm_manager.call_unified_model_2_stream(
            &llm_context,
            &messages,
            "",   // subject - Chat V2 不使用科目
            true, // enable_chain_of_thought
            enable_thinking,
            Some("chat_v2"),
            window,
            &stream_event,
            Some(ctx.assistant_message_id.as_str()),
            None, // trace_id
            disable_tools,
            max_input_tokens_override, // 🔧 P1修复：传递 context_limit 作为输入 token 限制
            model_override.clone(),
            temp_override,
            system_prompt_override.clone(),
            top_p_override,
            frequency_penalty_override,
            presence_penalty_override,
            max_tokens_override,
        );

        const LLM_MAX_RETRIES: u32 = 2;
        const LLM_RETRY_DELAY_MS: u64 = 1000;

        let mut call_result =
            match timeout(Duration::from_secs(LLM_STREAM_TIMEOUT_SECS), llm_future).await {
                Ok(result) => result,
                Err(_) => {
                    log::error!(
                        "[ChatV2::pipeline] LLM stream call timeout after {}s, session={}",
                        LLM_STREAM_TIMEOUT_SECS,
                        ctx.session_id
                    );
                    return Err(ChatV2Error::Timeout(format!(
                        "LLM stream call timed out after {}s",
                        LLM_STREAM_TIMEOUT_SECS
                    )));
                }
            };

        // 瞬时网络错误自动重试（最多 LLM_MAX_RETRIES 次）
        if call_result.is_err() {
            let err_str = format!("{:?}", call_result.as_ref().err().unwrap());
            let is_transient = err_str.contains("connection")
                || err_str.contains("timeout")
                || err_str.contains("reset")
                || err_str.contains("broken pipe")
                || err_str.contains("connect")
                || err_str.contains("temporarily unavailable")
                || err_str.contains("status: 429")
                || err_str.contains("status: 502")
                || err_str.contains("status: 503")
                || err_str.contains("status: 504");

            if is_transient
                && !ctx
                    .cancellation_token
                    .as_ref()
                    .map(|t| t.is_cancelled())
                    .unwrap_or(false)
            {
                for retry in 1..=LLM_MAX_RETRIES {
                    let delay = LLM_RETRY_DELAY_MS * (1 << (retry - 1));
                    log::warn!(
                        "[ChatV2::pipeline] Transient LLM error, retry {}/{} after {}ms: {}",
                        retry,
                        LLM_MAX_RETRIES,
                        delay,
                        err_str
                    );
                    tokio::time::sleep(Duration::from_millis(delay)).await;

                    if ctx
                        .cancellation_token
                        .as_ref()
                        .map(|t| t.is_cancelled())
                        .unwrap_or(false)
                    {
                        break;
                    }

                    // 重新注册 hooks 以清理首次失败调用的累积状态
                    self.llm_manager
                        .unregister_stream_hooks(&stream_event)
                        .await;
                    self.llm_manager
                        .register_stream_hooks(&stream_event, adapter.clone())
                        .await;

                    let retry_future = self.llm_manager.call_unified_model_2_stream(
                        &llm_context,
                        &messages,
                        "",
                        true,
                        enable_thinking,
                        Some("chat_v2"),
                        emitter.window(),
                        &stream_event,
                        Some(ctx.assistant_message_id.as_str()),
                        None,
                        disable_tools,
                        max_input_tokens_override,
                        model_override.clone(),
                        temp_override,
                        system_prompt_override.clone(),
                        top_p_override,
                        frequency_penalty_override,
                        presence_penalty_override,
                        max_tokens_override,
                    );

                    call_result =
                        match timeout(Duration::from_secs(LLM_STREAM_TIMEOUT_SECS), retry_future)
                            .await
                        {
                            Ok(result) => result,
                            Err(_) => continue,
                        };

                    if call_result.is_ok() {
                        log::info!("[ChatV2::pipeline] LLM retry {} succeeded", retry);
                        break;
                    }
                }
            }
        }

        // 注销 hooks
        self.llm_manager
            .unregister_stream_hooks(&stream_event)
            .await;

        // 处理 LLM 调用结果
        match call_result {
            Ok(output) => {
                log::info!(
                    "[ChatV2::pipeline] LLM call succeeded, cancelled={}, content_len={}",
                    output.cancelled,
                    output.assistant_message.len()
                );

                // 更新上下文
                ctx.final_content = adapter.get_accumulated_content();
                ctx.final_reasoning = adapter.get_accumulated_reasoning();
                // 🔧 修复：保存流式过程中创建的块 ID，确保 save_results 使用相同的 ID
                ctx.streaming_thinking_block_id = adapter.get_thinking_block_id();
                ctx.streaming_content_block_id = adapter.get_content_block_id();

                log::info!(
                    "[ChatV2::pipeline] After LLM call: final_content_len={}, final_reasoning={:?}, thinking_block_id={:?}, content_block_id={:?}",
                    ctx.final_content.len(),
                    ctx.final_reasoning.as_ref().map(|r| r.len()),
                    ctx.streaming_thinking_block_id,
                    ctx.streaming_content_block_id
                );

                // 如果 adapter 累积内容为空但输出不为空，使用 LLM 输出
                if ctx.final_content.is_empty() && !output.assistant_message.is_empty() {
                    ctx.final_content = output.assistant_message.clone();
                }

                // ============================================================
                // Token 使用量统计与累加（Prompt 4）
                // ============================================================
                let round_usage = self.get_or_estimate_usage(
                    &adapter,
                    &messages,
                    &ctx.final_content,
                    system_prompt,
                    ctx.options.model_id.as_deref(),
                );

                // 累加到 PipelineContext.token_usage
                ctx.token_usage.accumulate(&round_usage);

                log::info!(
                    "[ChatV2::pipeline] Token usage for round {}: prompt={}, completion={}, total={}, source={}; Accumulated: prompt={}, completion={}, total={}, source={}",
                    recursion_depth,
                    round_usage.prompt_tokens,
                    round_usage.completion_tokens,
                    round_usage.total_tokens,
                    round_usage.source,
                    ctx.token_usage.prompt_tokens,
                    ctx.token_usage.completion_tokens,
                    ctx.token_usage.total_tokens,
                    ctx.token_usage.source
                );

                // 记录 LLM 使用量到数据库
                // 🔧 修复：优先使用解析后的模型显示名称，避免显示配置 ID
                let model_for_usage = ctx
                    .model_display_name
                    .as_deref()
                    .or(ctx.options.model_id.as_deref())
                    .unwrap_or("unknown");
                crate::llm_usage::record_llm_usage(
                    crate::llm_usage::CallerType::ChatV2,
                    model_for_usage,
                    round_usage.prompt_tokens,
                    round_usage.completion_tokens,
                    None, // reasoning_tokens - adapter 层面已单独处理
                    None, // cached_tokens
                    Some(ctx.session_id.clone()),
                    None, // duration_ms - 在 adapter 层面已记录
                    true,
                    None,
                );
            }
            Err(e) => {
                // 调用 adapter 的错误处理
                adapter.on_error(&e.to_string());
                log::error!("[ChatV2::pipeline] LLM call failed: {}", e);

                // 记录失败的 LLM 调用
                // 🔧 修复：优先使用解析后的模型显示名称，避免显示配置 ID
                let model_for_usage = ctx
                    .model_display_name
                    .as_deref()
                    .or(ctx.options.model_id.as_deref())
                    .unwrap_or("unknown");
                crate::llm_usage::record_llm_usage(
                    crate::llm_usage::CallerType::ChatV2,
                    model_for_usage,
                    0,
                    0,
                    None,
                    None,
                    Some(ctx.session_id.clone()),
                    None,
                    false,
                    Some(e.to_string()),
                );

                return Err(ChatV2Error::Llm(e.to_string()));
            }
        }

        // ============================================================
        // 处理 LLM 返回的工具调用
        // 工具调用通过 LLMStreamHooks.on_tool_call() 回调收集到 adapter 中。
        // 在 LLM 调用完成后，从 adapter 取出收集到的工具调用进行处理。
        // ============================================================
        let tool_calls = adapter.take_tool_calls();

        // 如果有工具调用，执行并递归
        if !tool_calls.is_empty() {
            log::info!(
                "[ChatV2::pipeline] LLM returned {} tool calls, executing sequentially...",
                tool_calls.len()
            );

            // ============================================================
            // Interleaved Thinking 支持：收集本轮产生的 thinking/content 块
            // 在工具调用之前，将本轮的 thinking 块添加到交替列表
            // 注意：工具调用模式下，LLM 通常不会返回 content（返回 tool_use 代替）
            // ============================================================
            let current_reasoning = adapter.get_accumulated_reasoning();
            ctx.collect_round_blocks(
                adapter.get_thinking_block_id(),
                current_reasoning.clone(),
                None, // 工具调用模式下，content 块通常为空
                None,
                &ctx.assistant_message_id.clone(),
            );

            // 🔧 修复：发射 thinking 块的 end 事件，通知前端思维链已结束
            // 之前只调用了 collect_round_blocks 收集数据，但没有发射 end 事件
            // 这导致前端一直显示"思考中..."状态
            adapter.finalize_all();

            // 🔧 DeepSeek Thinking Mode：保存 reasoning_content 用于下一轮 API 调用
            // 根据 DeepSeek API 文档，在工具调用迭代中需要回传 reasoning_content
            ctx.pending_reasoning_for_api = current_reasoning;
            log::debug!(
                "[ChatV2::pipeline] Interleaved: collected thinking block for round {}, total blocks={}, pending_reasoning={}",
                recursion_depth,
                ctx.interleaved_block_ids.len(),
                ctx.pending_reasoning_for_api.as_ref().map(|s| s.len()).unwrap_or(0)
            );

            // ============================================================
            // 🆕 P15 修复（补充）：工具执行前中间保存点
            // 确保 thinking 块等已生成内容在工具执行（可能阻塞）前被持久化
            // 关键场景：coordinator_sleep 会阻塞，如果只在工具执行后保存，保存永远不会执行
            // ============================================================
            if let Err(e) = self.save_intermediate_results(ctx).await {
                log::warn!(
                    "[ChatV2::pipeline] Failed to save intermediate results before tool execution: {}",
                    e
                );
            } else if !ctx.interleaved_blocks.is_empty() {
                log::info!(
                    "[ChatV2::pipeline] Pre-tool intermediate save completed, blocks={}",
                    ctx.interleaved_block_ids.len()
                );
            }

            // 并行执行所有工具调用
            let canvas_note_id = ctx.options.canvas_note_id.clone();
            let skill_contents = ctx.options.skill_contents.clone();
            let active_skill_ids = ctx.options.active_skill_ids.clone();
            let rag_top_k = ctx.options.rag_top_k;
            let rag_enable_reranking = ctx.options.rag_enable_reranking;
            let memory_enabled = ctx.options.memory_enabled.unwrap_or(true);
            let rag_enabled = ctx.options.rag_enabled.unwrap_or(true);
            let web_search_enabled = ctx.options.web_search_enabled.unwrap_or(true);
            // 🆕 取消支持：传递取消令牌给工具执行器
            let cancel_token = ctx.cancellation_token();
            let round_id = format!("tool-round-{}", recursion_depth);
            let tool_results = self
                .execute_tool_calls(
                    &tool_calls,
                    &emitter,
                    &ctx.session_id,
                    &ctx.assistant_message_id,
                    None,
                    ctx.options.skill_state_version,
                    Some(round_id.as_str()),
                    &canvas_note_id,
                    &skill_contents,
                    &active_skill_ids,
                    cancel_token,
                    rag_top_k,
                    rag_enable_reranking,
                    memory_enabled,
                    rag_enabled,
                    web_search_enabled,
                    &mcp_tool_name_mapping,
                )
                .await?;

            // 记录执行结果
            let success_count = tool_results.iter().filter(|r| r.success).count();
            log::info!(
                "[ChatV2::pipeline] Tool execution completed: {}/{} succeeded",
                success_count,
                tool_results.len()
            );

            // ============================================================
            // 🆕 渐进披露：load_skills 执行后动态追加工具到 tools 数组
            // ============================================================
            for tool_result in &tool_results {
                if super::super::tools::SkillsExecutor::is_load_skills_tool(&tool_result.tool_name)
                    && tool_result.success
                {
                    // 从工具结果中提取加载的 skill_ids
                    if let Some(skill_ids) = tool_result
                        .output
                        .get("result")
                        .and_then(|r| r.get("skill_ids"))
                        .and_then(|ids| ids.as_array())
                    {
                        let loaded_skill_ids: Vec<String> = skill_ids
                            .iter()
                            .filter_map(|id| id.as_str().map(|s| s.to_string()))
                            .collect();

                        if !loaded_skill_ids.is_empty() {
                            // 从 skill_embedded_tools 中获取对应的工具 Schema
                            if let Some(ref embedded_tools_map) = ctx.options.skill_embedded_tools {
                                let mut new_tools: Vec<super::super::types::McpToolSchema> =
                                    Vec::new();
                                for skill_id in &loaded_skill_ids {
                                    if let Some(tools) = embedded_tools_map.get(skill_id) {
                                        for tool in tools {
                                            new_tools.push(tool.clone());
                                        }
                                    }
                                }

                                if !new_tools.is_empty() {
                                    // 动态追加到 mcp_tool_schemas（去重）
                                    let mcp_schemas =
                                        ctx.options.mcp_tool_schemas.get_or_insert_with(Vec::new);
                                    let before_count = mcp_schemas.len();

                                    // 收集已存在的工具名称用于去重（使用 owned String 避免借用问题）
                                    let existing_names: std::collections::HashSet<String> =
                                        mcp_schemas.iter().map(|t| t.name.clone()).collect();

                                    let mut added_count = 0;
                                    for tool in new_tools {
                                        if !existing_names.contains(&tool.name) {
                                            mcp_schemas.push(tool);
                                            added_count += 1;
                                        }
                                    }

                                    if added_count > 0 {
                                        log::info!(
                                            "[ChatV2::pipeline] 🆕 Progressive disclosure: added {} tools from skills {:?}, total tools: {} -> {}",
                                            added_count,
                                            loaded_skill_ids,
                                            before_count,
                                            mcp_schemas.len()
                                        );
                                    }
                                }

                            }
                        }
                    }
                }
            }

            // ============================================================
            // Interleaved Thinking 支持：添加工具调用块到交替列表
            // ============================================================
            let message_id = ctx.assistant_message_id.clone();
            for tool_result in &tool_results {
                ctx.add_tool_block(tool_result, &message_id);
            }
            log::debug!(
                "[ChatV2::pipeline] Interleaved: added {} tool blocks, total blocks={}",
                tool_results.len(),
                ctx.interleaved_block_ids.len()
            );

            // 🆕 文档 29 P1-4：检测 attempt_completion 的 task_completed 标志
            // 如果检测到任务完成，终止递归循环，不再继续调用 LLM
            let task_completed = tool_results.iter().any(|r| {
                r.output
                    .get("task_completed")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
            });

            // 🔒 安全修复：心跳检测仅信任白名单内部工具
            let has_continue_execution = tool_results.iter().any(|r| {
                HEARTBEAT_TOOLS.contains(&r.tool_name.as_str())
                    && r.output
                        .get("continue_execution")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false)
            });
            if has_continue_execution {
                log::info!(
                    "[ChatV2::pipeline] Heartbeat detected from whitelisted tool, will bypass recursion limit (count: {})",
                    ctx.heartbeat_count
                );
            }

            // 🆕 持久化 TodoList 状态（消息内继续执行支持）
            // 检测是否有 todo 工具调用，如果有则持久化到数据库
            for tool_result in &tool_results {
                if tool_result.tool_name.contains("todo_") {
                    // 从内存获取当前 TodoList 状态并持久化
                    if let Some(todo_list) =
                        super::super::tools::todo_executor::get_todo_list(&ctx.session_id)
                    {
                        if let Err(e) = super::super::tools::todo_executor::persist_todo_list(
                            &self.db,
                            &ctx.session_id,
                            &ctx.assistant_message_id,
                            None, // variant_id 暂时为 None，后续可从 ctx 获取
                            &todo_list,
                        ) {
                            log::warn!("[ChatV2::pipeline] Failed to persist TodoList: {}", e);
                        } else {
                            log::debug!(
                                "[ChatV2::pipeline] TodoList persisted: session={}, progress={}/{}",
                                ctx.session_id,
                                todo_list.completed_count(),
                                todo_list.total_count()
                            );
                        }
                    }
                    break; // 只需持久化一次
                }
            }

            // 将工具结果添加到上下文
            // 🔧 思维链修复：为这一批工具结果中的第一个附加当前轮次的思维链
            // 一轮 LLM 调用可能产生多个工具调用，但只有一个思维链
            // 🔧 Gemini 3 修复：同时附加 thought_signature（工具调用必需）
            let cached_thought_sig = adapter.get_thought_signature();
            let tool_results_with_reasoning: Vec<_> = tool_results
                .into_iter()
                .enumerate()
                .map(|(i, mut result)| {
                    if i == 0 {
                        // 只有第一个工具结果携带这一轮的思维链
                        result.reasoning_content = ctx.pending_reasoning_for_api.clone();
                        // 🔧 Gemini 3：附加 thought_signature 以便后续请求回传
                        result.thought_signature = cached_thought_sig.clone();
                    }
                    result
                })
                .collect();
            ctx.add_tool_results(tool_results_with_reasoning);

            // ============================================================
            // 🆕 P15 修复：工具执行后中间保存点
            // 确保工具执行结果被持久化，防止后续阻塞操作（如睡眠）期间刷新丢失数据
            // ============================================================
            if let Err(e) = self.save_intermediate_results(ctx).await {
                log::warn!(
                    "[ChatV2::pipeline] Failed to save intermediate results after tool execution: {}",
                    e
                );
                // 不阻塞流程，继续执行
            } else {
                log::info!(
                    "[ChatV2::pipeline] Intermediate save completed after tool round {}, blocks={}",
                    recursion_depth,
                    ctx.interleaved_block_ids.len()
                );
            }

            // ============================================================
            // 空闲期检测点 2：工具执行完成后检查 inbox
            // 设计文档 30：在工具执行完成后、下一轮 LLM 调用前检查
            // ============================================================
            if let Some(workspace_id) = ctx.get_workspace_id() {
                if let Some(ref coordinator) = self.workspace_coordinator {
                    use super::super::workspace::WorkspaceInjector;

                    let injector = WorkspaceInjector::new(coordinator.clone());
                    let max_injections = 2u32; // 工具执行后最多处理 2 批消息

                    if let Ok(injection_result) =
                        injector.check_and_inject(workspace_id, &ctx.session_id, max_injections)
                    {
                        if !injection_result.messages.is_empty() {
                            let formatted = WorkspaceInjector::format_injected_messages(
                                &injection_result.messages,
                            );
                            ctx.inject_workspace_messages(formatted);

                            log::info!(
                                "[ChatV2::pipeline] Workspace tool-phase injection: {} messages, depth={}",
                                injection_result.messages.len(),
                                recursion_depth
                            );
                        }
                    }
                }
            }

            if task_completed {
                log::info!(
                    "[ChatV2::pipeline] Task completed detected via attempt_completion, stopping recursive loop at depth={}",
                    recursion_depth
                );

                // 收集当前轮次的块（无需再次调用 LLM）
                ctx.collect_round_blocks(
                    adapter.get_thinking_block_id(),
                    adapter.get_accumulated_reasoning(),
                    adapter.get_content_block_id(),
                    Some(ctx.final_content.clone()),
                    &ctx.assistant_message_id.clone(),
                );

                // 清除 pending_reasoning
                ctx.pending_reasoning_for_api = None;

                return Ok(());
            }

            // 递归调用 LLM 处理工具结果
            log::debug!(
                "[ChatV2::pipeline] Recursively calling LLM to process tool results, depth={}->{}",
                recursion_depth,
                recursion_depth + 1
            );
            return Box::pin(self.execute_with_tools(
                ctx,
                emitter,
                system_prompt,
                recursion_depth + 1,
            ))
            .await;
        }

        // ============================================================
        // 无工具调用，这是最后一轮 LLM 调用
        // 收集最终的 thinking 和 content 块
        // ============================================================
        ctx.collect_round_blocks(
            adapter.get_thinking_block_id(),
            adapter.get_accumulated_reasoning(),
            adapter.get_content_block_id(),
            Some(ctx.final_content.clone()),
            &ctx.assistant_message_id.clone(),
        );

        // 🔧 DeepSeek Thinking Mode：清除 pending_reasoning
        // 根据 DeepSeek API 文档，新的用户问题不需要回传之前的 reasoning_content
        ctx.pending_reasoning_for_api = None;

        log::info!(
            "[ChatV2::pipeline] LLM call completed without tool calls, recursion_depth={}, total interleaved_blocks={}",
            recursion_depth,
            ctx.interleaved_block_ids.len()
        );

        Ok(())
    }

    /// 并行执行多个工具调用
    ///
    /// 使用 `futures::future::join_all` 并行执行所有工具调用，
    /// 超时策略由 ToolExecutorRegistry 统一控制。
    ///
    /// ## 参数
    /// - `tool_calls`: 工具调用列表
    /// - `emitter`: 事件发射器
    /// - `session_id`: 会话 ID（用于工具状态隔离，如 TodoList）
    /// - `message_id`: 消息 ID（用于关联块）
    /// - `canvas_note_id`: Canvas 笔记 ID，用于 Canvas 工具默认值
    /// - `skill_allowed_tools`: 🆕 P1-C Skill 工具白名单（如果设置，只允许执行白名单中的工具）
    ///
    /// ## 返回
    /// 工具调用结果列表
    /// 对工具调用列表进行依赖感知排序
    ///
    /// 规则（按优先级从高到低）：
    /// 1. chatanki: run/start → control → status/analyze → wait → export/sync
    /// 2. pptx/xlsx/docx: _create 必须在 _read/_extract/_get/_replace/_edit/_to_spec 之前
    /// 3. 同优先级内保持原始顺序（stable sort）
    fn ordered_tool_calls_for_execution(&self, tool_calls: &[ToolCall]) -> Vec<ToolCall> {
        /// 剥离工具名前缀，返回短名
        fn strip_tool_prefix(tool_name: &str) -> &str {
            // builtin-xxx, mcp_xxx, mcp.tools.xxx, namespace.xxx
            tool_name
                .strip_prefix(BUILTIN_NAMESPACE)
                .or_else(|| tool_name.strip_prefix("mcp_"))
                .or_else(|| tool_name.strip_prefix("mcp.tools."))
                .unwrap_or(tool_name)
        }

        /// ChatAnki 工具优先级
        fn chatanki_priority(short_name: &str) -> Option<u8> {
            if !short_name.starts_with("chatanki_") {
                return None;
            }
            let p = match short_name {
                "chatanki_run" | "chatanki_start" => 0,
                "chatanki_control" => 1,
                "chatanki_status"
                | "chatanki_list_templates"
                | "chatanki_analyze"
                | "chatanki_check_anki_connect" => 2,
                "chatanki_wait" => 3,
                "chatanki_export" | "chatanki_sync" => 4,
                _ => 2,
            };
            Some(p)
        }

        /// 文档工具优先级（pptx/xlsx/docx）
        /// _create = 0, 其余 = 1, 不匹配 = None
        fn document_tool_priority(short_name: &str) -> Option<u8> {
            // 检测是否属于文档工具族
            let prefixes = ["pptx_", "xlsx_", "docx_"];
            let matched_prefix = prefixes.iter().find(|p| short_name.starts_with(**p));
            let prefix = match matched_prefix {
                Some(p) => *p,
                None => return None,
            };

            let action = &short_name[prefix.len()..];
            let p = match action {
                "create" => 0,                       // 创建文件 — 必须最先
                "read_structured" | "get_metadata"   // 只读操作
                | "extract_tables" => 1,
                "edit_cells" | "replace_text" => 2,  // 写操作（依赖文件存在）
                "to_spec" => 3,                      // 转换操作（依赖文件存在）
                _ => 1,                              // 未知动作，按只读对待
            };
            Some(p)
        }

        /// 综合优先级：(group_priority, action_priority)
        /// group 0 = chatanki, 1 = document, 99 = other
        fn tool_priority(tool_name: &str) -> (u8, u8) {
            let short = strip_tool_prefix(tool_name);
            if let Some(p) = chatanki_priority(short) {
                return (0, p);
            }
            if let Some(p) = document_tool_priority(short) {
                return (1, p);
            }
            (99, 0)
        }

        // 快速路径：如果没有需要排序的工具，直接返回原始顺序
        let needs_sort = tool_calls.iter().any(|call| {
            let short = strip_tool_prefix(&call.name);
            chatanki_priority(short).is_some() || document_tool_priority(short).is_some()
        });
        if !needs_sort {
            return tool_calls.to_vec();
        }

        let mut indexed_calls: Vec<(usize, ToolCall)> =
            tool_calls.iter().cloned().enumerate().collect();
        // stable sort: 先按 tool_priority，同优先级保持原始顺序（idx）
        indexed_calls.sort_by_key(|(idx, call)| {
            let (group, action) = tool_priority(&call.name);
            (group, action, *idx)
        });

        let reordered: Vec<ToolCall> = indexed_calls.into_iter().map(|(_, call)| call).collect();

        // 日志：如果顺序发生变化，记录重排结果
        if reordered
            .iter()
            .zip(tool_calls.iter())
            .any(|(a, b)| a.id != b.id)
        {
            let names: Vec<&str> = reordered.iter().map(|c| c.name.as_str()).collect();
            log::info!(
                "[ChatV2::pipeline] Tool calls reordered for dependency safety: {:?}",
                names
            );
        }

        reordered
    }

    pub(crate) async fn execute_tool_calls(
        &self,
        tool_calls: &[ToolCall],
        emitter: &Arc<ChatV2EventEmitter>,
        session_id: &str,
        message_id: &str,
        variant_id: Option<&str>,
        skill_state_version: Option<u64>,
        round_id: Option<&str>,
        canvas_note_id: &Option<String>,
        skill_contents: &Option<std::collections::HashMap<String, String>>,
        active_skill_ids: &Option<Vec<String>>,
        cancellation_token: Option<&CancellationToken>,
        rag_top_k: Option<u32>,
        rag_enable_reranking: Option<bool>,
        memory_enabled: bool,
        rag_enabled: bool,
        web_search_enabled: bool,
        tool_name_mapping: &HashMap<String, ExternalToolRoute>,
    ) -> ChatV2Result<Vec<ToolResultInfo>> {
        // 🔧 反向映射：LLM 返回的 sanitized 工具名 → 原始名（含 `:` 等特殊字符）
        let tool_calls: Vec<ToolCall> = tool_calls
            .iter()
            .map(|tc| {
                if let Some(route) = tool_name_mapping.get(&tc.name) {
                    log::debug!(
                        "[ChatV2::pipeline] Reverse-mapping tool name: {} → {}",
                        tc.name,
                        route.raw_tool_name
                    );
                    let mut arguments = tc.arguments.clone();
                    if let Some(server_id) = route.preferred_server_id.as_deref() {
                        if let Some(obj) = arguments.as_object_mut() {
                            obj.insert("_serverId".to_string(), json!(server_id));
                        }
                    }
                    ToolCall {
                        id: tc.id.clone(),
                        name: route.raw_tool_name.clone(),
                        arguments,
                    }
                } else {
                    tc.clone()
                }
            })
            .collect();
        let ordered_tool_calls = self.ordered_tool_calls_for_execution(&tool_calls);
        log::debug!(
            "[ChatV2::pipeline] Executing {} tool calls sequentially",
            ordered_tool_calls.len()
        );

        // 🔧 2026-02-16: 追踪本批次 _create 工具返回的 file_id，用于修正依赖工具中
        // LLM 凭空捏造的 resource_id（LLM 在同一批次生成 create + read/edit 时，
        // 无法提前知道 create 返回的实际 file_id）
        // key: 文档类型前缀 ("xlsx" / "pptx" / "docx")
        // value: create 工具返回的实际 file_id
        let mut created_file_ids: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();

        // 顺序执行工具调用，避免非幂等工具并发导致的数据竞态
        let mut tool_results = Vec::new();
        for tc in ordered_tool_calls.iter() {
            // 检测截断标记：LLM 输出被 max_tokens 截断导致工具调用 JSON 不完整
            // 此时不执行工具，直接返回错误 tool_result 让 LLM 缩小输出重试
            if tc
                .arguments
                .get("_truncation_error")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            {
                let error_msg = tc
                    .arguments
                    .get("_error_message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("工具调用参数被截断");
                let args_len = tc
                    .arguments
                    .get("_args_len")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);

                log::warn!(
                    "[ChatV2::pipeline] 工具调用 JSON 被截断，跳过执行并反馈 LLM 重试: tool={}, args_len={}",
                    tc.name,
                    args_len
                );

                // 🆕 P1 修复：生成 block_id 并发射前端事件，让用户看到截断错误
                let block_id = MessageBlock::generate_id();
                let truncation_display_msg = format!(
                    "工具调用 {} 的参数因输出长度超限被截断（已生成 {} 字符），工具未执行，正在自动重试。",
                    tc.name, args_len
                );

                // 发射 tool_call start 事件（创建前端块）
                emitter.emit_start_with_meta(
                    event_types::TOOL_CALL,
                    message_id,
                    Some(&block_id),
                    Some(json!({
                        "toolName": tc.name,
                        "toolInput": { "_truncated": true, "_args_len": args_len },
                        "toolCallId": tc.id,
                    })),
                    variant_id,
                    skill_state_version,
                    round_id,
                );

                // 发射 tool_call error 事件（标记块为错误状态）
                emitter.emit_error_with_meta(
                    event_types::TOOL_CALL,
                    &block_id,
                    &truncation_display_msg,
                    variant_id,
                    skill_state_version,
                    round_id,
                );

                let retry_hint = format!(
                    "CRITICAL ERROR: Tool call '{}' FAILED — your output was truncated at {} characters because it exceeded the max_tokens limit. The JSON arguments were incomplete and the tool was NOT executed.\n\n\
                    YOU MUST retry with significantly smaller arguments. Mandatory rules:\n\
                    1. Reduce the total argument size to under 50% of the previous attempt.\n\
                    2. For mindmap_create: create only the skeleton (top-level branches + minimal children), then use edit_nodes to add details incrementally.\n\
                    3. For any tool: remove verbose text, avoid deeply nested structures, keep JSON compact.\n\
                    4. If the content is inherently large, split it into multiple smaller tool calls.\n\n\
                    Do NOT repeat the same call with the same size — it will fail again.",
                    tc.name, args_len
                );

                tool_results.push(ToolResultInfo {
                    tool_call_id: Some(tc.id.clone()),
                    block_id: Some(block_id),
                    tool_name: tc.name.clone(),
                    input: tc.arguments.clone(),
                    output: json!({ "error": error_msg }),
                    success: false,
                    error: Some(retry_hint),
                    duration_ms: None,
                    reasoning_content: None,
                    thought_signature: None,
                });
                continue;
            }

            // 🔧 2026-02-16: 修正依赖工具的 resource_id
            // 当 LLM 在同一批次生成 create + 依赖工具时，依赖工具的 resource_id
            // 是 LLM 捏造的（因为 create 还没返回真实 ID）。
            // 这里检测并替换为本批次 create 返回的实际 file_id。
            let tc_to_execute = self.fixup_document_tool_resource_id(tc, &created_file_ids);
            let tc_ref = tc_to_execute.as_ref().unwrap_or(tc);

            match self
                .execute_single_tool(
                    tc_ref,
                    emitter,
                    session_id,
                    message_id,
                    variant_id,
                    skill_state_version,
                    round_id,
                    canvas_note_id,
                    skill_contents,
                    active_skill_ids,
                    cancellation_token.cloned(),
                    rag_top_k,
                    rag_enable_reranking,
                    memory_enabled,
                    rag_enabled,
                    web_search_enabled,
                )
                .await
            {
                Ok(info) => {
                    // 🔧 捕获 _create 工具返回的 file_id，供后续依赖工具使用
                    if info.success {
                        self.capture_created_file_id(
                            &tc_ref.name,
                            &info.output,
                            &mut created_file_ids,
                        );
                    }
                    tool_results.push(info);
                }
                Err(e) => {
                    log::error!(
                        "[ChatV2::pipeline] Unexpected tool call error for {}: {}",
                        tc.name,
                        e
                    );
                    tool_results.push(ToolResultInfo {
                        tool_call_id: Some(tc.id.clone()),
                        block_id: None,
                        tool_name: tc.name.clone(),
                        input: tc.arguments.clone(),
                        output: json!(null),
                        success: false,
                        error: Some(e.to_string()),
                        duration_ms: None,
                        reasoning_content: None,
                        thought_signature: None,
                    });
                }
            }
        }

        Ok(tool_results)
    }

    /// 🔧 2026-02-16: 修正依赖工具的 resource_id
    ///
    /// 当 LLM 在同一批次同时生成 `_create` 和 `_read/_edit` 等依赖工具时，
    /// 依赖工具的 `resource_id` 是 LLM 凭空捏造的（因为 create 尚未返回真实 ID）。
    /// 此方法检测这种情况并替换为本批次 _create 工具返回的实际 file_id。
    ///
    /// 替换条件（全部满足才替换）：
    /// 1. 工具是文档类型的非 _create 工具（如 xlsx_read_structured）
    /// 2. 参数中有 resource_id
    /// 3. 本批次有对应文档类型的 _create 结果
    /// 4. 当前 resource_id 与 _create 返回的不同
    /// 5. 当前 resource_id 在 VFS 中不存在（确认是捏造的）
    fn fixup_document_tool_resource_id(
        &self,
        tc: &ToolCall,
        created_file_ids: &std::collections::HashMap<String, String>,
    ) -> Option<ToolCall> {
        if created_file_ids.is_empty() {
            return None;
        }

        // 剥离前缀
        let short_name = tc
            .name
            .strip_prefix(super::super::tools::builtin_retrieval_executor::BUILTIN_NAMESPACE)
            .or_else(|| tc.name.strip_prefix("mcp_"))
            .unwrap_or(&tc.name);

        // 检测文档工具族
        let doc_type = if short_name.starts_with("pptx_") {
            "pptx"
        } else if short_name.starts_with("xlsx_") {
            "xlsx"
        } else if short_name.starts_with("docx_") {
            "docx"
        } else {
            return None;
        };

        // _create 工具本身不需要 fixup
        let action = &short_name[doc_type.len() + 1..]; // skip "xlsx_"
        if action == "create" {
            return None;
        }

        // 获取参数中的 resource_id
        let resource_id = tc.arguments.get("resource_id").and_then(|v| v.as_str())?;

        // 获取本批次 _create 返回的实际 file_id
        let actual_id = created_file_ids.get(doc_type)?;

        // 如果已经一致，无需替换
        if resource_id == actual_id.as_str() {
            return None;
        }

        // 检查原始 resource_id 是否在 VFS 中存在
        // 如果存在，说明 LLM 引用的是之前的文件，不应替换
        if let Some(ref vfs_db) = self.vfs_db {
            use crate::vfs::repos::VfsFileRepo;
            if let Ok(conn) = vfs_db.get_conn_safe() {
                if VfsFileRepo::get_file_with_conn(&conn, resource_id)
                    .ok()
                    .flatten()
                    .is_some()
                {
                    return None; // 原始 ID 有效，不替换
                }
            }
        }

        // 替换 resource_id
        let mut fixed_tc = tc.clone();
        if let Some(obj) = fixed_tc.arguments.as_object_mut() {
            obj.insert(
                "resource_id".to_string(),
                serde_json::Value::String(actual_id.clone()),
            );
        }

        log::info!(
            "[ChatV2::pipeline] 🔧 资源ID修正: {} 的 resource_id '{}' → '{}' (同批次 {}_create 返回)",
            tc.name, resource_id, actual_id, doc_type
        );

        Some(fixed_tc)
    }

    /// 🔧 2026-02-16: 捕获 _create 工具返回的 file_id
    fn capture_created_file_id(
        &self,
        tool_name: &str,
        output: &serde_json::Value,
        created_file_ids: &mut std::collections::HashMap<String, String>,
    ) {
        let short_name = tool_name
            .strip_prefix(super::super::tools::builtin_retrieval_executor::BUILTIN_NAMESPACE)
            .or_else(|| tool_name.strip_prefix("mcp_"))
            .unwrap_or(tool_name);

        let doc_type = if short_name.starts_with("pptx_") {
            "pptx"
        } else if short_name.starts_with("xlsx_") {
            "xlsx"
        } else if short_name.starts_with("docx_") {
            "docx"
        } else {
            return;
        };

        let action = &short_name[doc_type.len() + 1..];
        if action != "create" {
            return;
        }

        // 从输出中提取 file_id（可能嵌套在 result 内）
        let file_id = output.get("file_id").and_then(|v| v.as_str()).or_else(|| {
            output
                .get("result")
                .and_then(|r| r.get("file_id"))
                .and_then(|v| v.as_str())
        });

        if let Some(id) = file_id {
            log::info!(
                "[ChatV2::pipeline] 📦 捕获 {}_create 返回的 file_id: {}",
                doc_type,
                id
            );
            created_file_ids.insert(doc_type.to_string(), id.to_string());
        }
    }

    /// 执行单个工具调用
    ///
    /// 🆕 文档 29 P0-1: 委托给 ToolExecutorRegistry 执行
    ///
    /// ## 参数
    /// - `tool_call`: 工具调用
    /// - `emitter`: 事件发射器
    /// - `session_id`: 会话 ID（用于工具状态隔离，如 TodoList）
    /// - `message_id`: 消息 ID
    /// - `canvas_note_id`: Canvas 笔记 ID，用于 Canvas 工具默认值
    /// - `cancellation_token`: 🆕 取消令牌，用于工具执行取消
    ///
    /// ## 返回
    /// 工具调用结果
    async fn execute_single_tool(
        &self,
        tool_call: &ToolCall,
        emitter: &Arc<ChatV2EventEmitter>,
        session_id: &str,
        message_id: &str,
        variant_id: Option<&str>,
        skill_state_version: Option<u64>,
        round_id: Option<&str>,
        canvas_note_id: &Option<String>,
        skill_contents: &Option<std::collections::HashMap<String, String>>,
        active_skill_ids: &Option<Vec<String>>,
        cancellation_token: Option<CancellationToken>,
        rag_top_k: Option<u32>,
        rag_enable_reranking: Option<bool>,
        memory_enabled: bool,
        rag_enabled: bool,
        web_search_enabled: bool,
    ) -> ChatV2Result<ToolResultInfo> {
        let block_id = MessageBlock::generate_id();

        log::debug!(
            "[ChatV2::pipeline] Executing tool via ExecutorRegistry: name={}, id={}",
            tool_call.name,
            tool_call.id
        );

        let build_preflight_blocked_result = |error_message: String| {
            let payload = json!({
                "toolName": tool_call.name,
                "toolInput": tool_call.arguments,
                "toolCallId": tool_call.id,
            });
            emitter.emit_start_with_meta(
                event_types::TOOL_CALL,
                message_id,
                Some(&block_id),
                Some(payload),
                variant_id,
                skill_state_version,
                round_id,
            );
            emitter.emit_error_with_meta(
                event_types::TOOL_CALL,
                &block_id,
                &error_message,
                variant_id,
                skill_state_version,
                round_id,
            );
            ToolResultInfo {
                tool_call_id: Some(tool_call.id.clone()),
                block_id: Some(block_id.clone()),
                tool_name: tool_call.name.clone(),
                input: tool_call.arguments.clone(),
                output: json!(null),
                success: false,
                error: Some(error_message),
                duration_ms: None,
                reasoning_content: None,
                thought_signature: None,
            }
        };

        // Feature flag checks (memory, RAG, web search)
        let short_name = Self::canonical_tool_short_name(&tool_call.name);
        let is_memory_tool = short_name.starts_with("memory_");
        let is_rag_tool = short_name.starts_with("rag_");
        let is_web_search_tool = short_name == "web_search";

        if is_memory_tool && !memory_enabled {
            return Ok(build_preflight_blocked_result(
                "memory 功能已关闭，工具调用被拦截".to_string(),
            ));
        }
        if is_rag_tool && !rag_enabled {
            return Ok(build_preflight_blocked_result(
                "RAG 功能已关闭，工具调用被拦截".to_string(),
            ));
        }
        if is_web_search_tool && !web_search_enabled {
            return Ok(build_preflight_blocked_result(
                "WebSearch 功能已关闭，工具调用被拦截".to_string(),
            ));
        }

        // 🆕 文档 29 P1-3：检查工具敏感等级，决定是否需要用户审批
        let sensitivity = self.executor_registry.get_sensitivity(&tool_call.name);

        // 🆕 全局免审批开关和单工具覆盖：
        // 1. 全局开关 tool_approval.global_bypass = "true" → 所有工具跳过审批
        // 2. 单工具覆盖 tool_approval.override.{tool_name} = "low" → 此工具跳过审批
        let effective_sensitivity = if let Some(ref db) = self.main_db {
            // 检查全局旁路开关
            let global_bypass = db
                .get_setting("tool_approval.global_bypass")
                .ok()
                .flatten()
                .map(|v| v == "true")
                .unwrap_or(false);

            if global_bypass {
                Some(ToolSensitivity::Low)
            } else {
                // 检查单工具覆盖
                let override_key = format!("tool_approval.override.{}", tool_call.name);
                if let Some(override_val) = db.get_setting(&override_key).ok().flatten() {
                    match override_val.as_str() {
                        "low" => Some(ToolSensitivity::Low),
                        "medium" => Some(ToolSensitivity::Medium),
                        "high" => Some(ToolSensitivity::High),
                        _ => sensitivity,
                    }
                } else {
                    sensitivity
                }
            }
        } else {
            sensitivity
        };

        if effective_sensitivity != Some(ToolSensitivity::Low) {
            if let Some(approval_manager) = &self.approval_manager {
                // 🔧 P1-51: 优先检查数据库中的持久化审批设置
                let persisted_approval: Option<bool> = self.main_db.as_ref().and_then(|db| {
                    let setting_key =
                        approval_scope_setting_key(&tool_call.name, &tool_call.arguments);
                    db.get_setting(&setting_key)
                        .ok()
                        .flatten()
                        .map(|v| v == "allow")
                });

                // 使用持久化设置或内存缓存
                let remembered = persisted_approval.or_else(|| {
                    approval_manager.check_remembered(&tool_call.name, &tool_call.arguments)
                });

                if let Some(is_allowed) = remembered {
                    log::info!(
                        "[ChatV2::pipeline] Tool {} approval remembered: {} (persisted={})",
                        tool_call.name,
                        is_allowed,
                        persisted_approval.is_some()
                    );
                    if !is_allowed {
                        // 用户之前选择了"始终拒绝"
                        return Ok(build_preflight_blocked_result(
                            "用户已拒绝此工具执行".to_string(),
                        ));
                    }
                    // 用户之前选择了"始终允许"，继续执行
                } else {
                    // 需要请求用户审批
                    let actual_sensitivity = sensitivity.unwrap_or(ToolSensitivity::Medium);
                    let approval_outcome = self
                        .request_tool_approval(
                            tool_call,
                            emitter,
                            session_id,
                            message_id,
                            &block_id,
                            &actual_sensitivity,
                            approval_manager,
                        )
                        .await;

                    match approval_outcome {
                        ApprovalOutcome::Approved => {
                            // 用户同意，继续执行
                        }
                        ApprovalOutcome::Rejected => {
                            return Ok(build_preflight_blocked_result(
                                "用户拒绝执行此工具".to_string(),
                            ));
                        }
                        ApprovalOutcome::Timeout => {
                            return Ok(build_preflight_blocked_result(
                                "工具审批等待超时，请重试".to_string(),
                            ));
                        }
                        ApprovalOutcome::ChannelClosed => {
                            return Ok(build_preflight_blocked_result(
                                "工具审批通道异常关闭，请重试".to_string(),
                            ));
                        }
                    }
                }
            }
        }

        // 🆕 构建执行上下文（文档 29 P0-1）
        let window = emitter.window();
        let mut ctx = ExecutionContext::new(
            session_id.to_string(),
            message_id.to_string(),
            block_id.clone(),
            emitter.clone(),
            self.tool_registry.clone(),
            window,
        )
        .with_canvas(canvas_note_id.clone(), self.notes_manager.clone())
        .with_main_db(self.main_db.clone())
        .with_anki_db(self.anki_db.clone())
        .with_vfs_db(self.vfs_db.clone()) // 🆕 学习资源工具需要访问 VFS 数据库
        .with_llm_manager(Some(self.llm_manager.clone())) // 🆕 VFS RAG 工具需要 LLM 管理器
        .with_chat_v2_db(Some(self.db.clone())) // 🆕 工具块防闪退保存
        .with_question_bank_service(self.question_bank_service.clone()) // 🆕 智能题目集工具
        .with_pdf_processing_service(self.pdf_processing_service.clone()) // 🆕 论文保存触发 Pipeline
        .with_rag_config(rag_top_k, rag_enable_reranking)
        .with_variant_id(variant_id.map(|s| s.to_string()))
        .with_event_meta(skill_state_version, round_id.map(|s| s.to_string()));

        ctx.emitter.register_block_event_meta(
            &ctx.block_id,
            ctx.variant_id.as_deref(),
            ctx.skill_state_version,
            ctx.round_id.as_deref(),
        );

        // 🆕 渐进披露：传递 skill_contents
        ctx.skill_contents = skill_contents.clone();

        // 🆕 取消支持：传递取消令牌
        if let Some(token) = cancellation_token {
            ctx = ctx.with_cancellation_token(token);
        }

        // 🆕 委托给 ExecutorRegistry 执行
        match self.executor_registry.execute(tool_call, &ctx).await {
            Ok(result) => Ok(result),
            Err(error_msg) => {
                ctx.emitter.emit_error_with_meta(
                    event_types::TOOL_CALL,
                    &ctx.block_id,
                    &error_msg,
                    variant_id,
                    skill_state_version,
                    round_id,
                );
                // 执行器内部错误，构造失败结果
                log::error!(
                    "[ChatV2::pipeline] Executor error for tool {}: {}",
                    tool_call.name,
                    error_msg
                );
                Ok(ToolResultInfo {
                    tool_call_id: Some(tool_call.id.clone()),
                    block_id: Some(block_id),
                    tool_name: tool_call.name.clone(),
                    input: tool_call.arguments.clone(),
                    output: json!(null),
                    success: false,
                    error: Some(error_msg),
                    duration_ms: None,
                    reasoning_content: None,
                    thought_signature: None,
                })
            }
        }
    }

    fn canonical_tool_short_name(tool_name: &str) -> &str {
        tool_name
            .strip_prefix(super::super::tools::builtin_retrieval_executor::BUILTIN_NAMESPACE)
            .or_else(|| tool_name.strip_prefix("mcp_"))
            .unwrap_or(tool_name)
    }

    /// 请求用户审批敏感工具
    ///
    /// 🆕 文档 29 P1-3：发射审批事件并等待用户响应
    ///
    /// 返回 `ApprovalOutcome` 以区分用户同意、拒绝、超时、通道异常等情况。
    async fn request_tool_approval(
        &self,
        tool_call: &ToolCall,
        emitter: &Arc<ChatV2EventEmitter>,
        session_id: &str,
        message_id: &str,
        block_id: &str,
        sensitivity: &ToolSensitivity,
        approval_manager: &Arc<ApprovalManager>,
    ) -> ApprovalOutcome {
        let timeout_seconds = approval_manager.default_timeout();
        let approval_block_id = format!("approval_{}", tool_call.id);

        // 构建审批请求
        let request = ApprovalRequest {
            session_id: session_id.to_string(),
            tool_call_id: tool_call.id.clone(),
            tool_name: tool_call.name.clone(),
            arguments: tool_call.arguments.clone(),
            sensitivity: match sensitivity {
                ToolSensitivity::Low => "low".to_string(),
                ToolSensitivity::Medium => "medium".to_string(),
                ToolSensitivity::High => "high".to_string(),
            },
            description: ApprovalManager::generate_description(
                &tool_call.name,
                &tool_call.arguments,
            ),
            timeout_seconds,
        };

        // 注册等待
        let rx = approval_manager.register_with_scope(
            session_id,
            &tool_call.id,
            &tool_call.name,
            &tool_call.arguments,
        );

        // 发射审批请求事件到前端
        log::info!(
            "[ChatV2::pipeline] Emitting tool approval request: tool={}, sensitivity={:?}",
            tool_call.name,
            sensitivity
        );
        let payload = serde_json::to_value(&request).ok();
        log::debug!(
            "[ChatV2::pipeline] tool approval block mapping: tool_block_id={}, approval_block_id={}",
            block_id,
            approval_block_id
        );
        emitter.emit_start(
            event_types::TOOL_APPROVAL_REQUEST,
            message_id,
            Some(&approval_block_id),
            payload,
            None, // variant_id
        );

        // 等待响应或超时
        let timeout_duration = std::time::Duration::from_secs(timeout_seconds as u64);
        match tokio::time::timeout(timeout_duration, rx).await {
            Ok(Ok(response)) => {
                log::info!(
                    "[ChatV2::pipeline] Received approval response: approved={}",
                    response.approved
                );
                let result_payload = serde_json::json!({
                    "toolCallId": tool_call.id,
                    "approved": response.approved,
                    "reason": response.reason,
                });
                emitter.emit_end(
                    event_types::TOOL_APPROVAL_REQUEST,
                    &approval_block_id,
                    Some(result_payload),
                    None,
                );
                if response.approved {
                    ApprovalOutcome::Approved
                } else {
                    ApprovalOutcome::Rejected
                }
            }
            Ok(Err(_)) => {
                // channel 被关闭（不应该发生）
                log::warn!("[ChatV2::pipeline] Approval channel closed unexpectedly");
                emitter.emit_error(
                    event_types::TOOL_APPROVAL_REQUEST,
                    &approval_block_id,
                    "approval_channel_closed",
                    None,
                );
                approval_manager.cancel_with_session(session_id, &tool_call.id);
                ApprovalOutcome::ChannelClosed
            }
            Err(_) => {
                // 超时
                log::warn!(
                    "[ChatV2::pipeline] Approval timeout for tool: {}",
                    tool_call.name
                );
                approval_manager.cancel_with_session(session_id, &tool_call.id);
                emitter.emit_error(
                    event_types::TOOL_APPROVAL_REQUEST,
                    &approval_block_id,
                    "approval_timeout",
                    None,
                );
                ApprovalOutcome::Timeout
            }
        }
    }
}
