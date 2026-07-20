use super::*;

impl ChatV2Pipeline {
    /// 检索阶段（已废弃预调用模式）
    ///
    /// 🔧 2026-01-11 重构：彻底移除预调用检索，完全采用工具化模式
    ///
    /// 原预调用模式（已废弃）：
    /// - 在 LLM 调用前自动执行 RAG、图谱、记忆、网络搜索
    /// - 结果注入到系统提示中
    ///
    /// 新工具化模式（当前）：
    /// - 检索工具作为 MCP 工具注入到 LLM
    /// - LLM 根据用户问题主动决定是否调用检索工具
    /// - 更智能、更节省资源
    ///
    /// 内置检索工具（builtin-* 前缀）：
    /// - builtin-rag_search - 知识库检索
    /// - builtin-graph_search - 知识图谱检索
    /// - builtin-memory_search - 对话记忆检索
    /// - builtin-web_search - 网络搜索
    /// - builtin-resource_* - 学习资源工具
    /// - builtin-note_* - Canvas 笔记工具
    /// - builtin-memory_* - VFS 记忆工具
    /// - builtin-knowledge_* - 知识内化工具
    #[allow(unused_variables)]
    pub(crate) async fn execute_retrievals(
        &self,
        ctx: &mut PipelineContext,
        _emitter: Arc<ChatV2EventEmitter>,
    ) -> ChatV2Result<()> {
        // 🔧 工具化模式：跳过所有预调用检索
        // 检索由 LLM 通过 tool_calls 主动调用内置工具完成
        log::info!(
            "[ChatV2::pipeline] Tool-based retrieval mode: skipping pre-call retrievals for session={}",
            ctx.session_id
        );
        Ok(())
    }

    // 🔧 P2-12（2026-07）死代码清理：删除了 execute_vfs_rag_retrieval /
    // execute_multimodal_retrieval / execute_memory_retrieval / execute_web_search
    // 四个私有函数 —— 自 2026-01-11 检索工具化重构后 execute_retrievals 变为
    // 空实现，这些预调用检索路径已无任何调用点（等价能力在
    // tools/builtin_retrieval_executor.rs）。
    #[cfg(any())]
    async fn execute_vfs_rag_retrieval_removed(
        &self,
        query: &str,
        folder_ids: Option<Vec<String>>,
        resource_types: Option<Vec<String>>,
        top_k: u32,
        enable_reranking: bool,
        enabled: bool,
        emitter: &Arc<ChatV2EventEmitter>,
        message_id: &str,
    ) -> ChatV2Result<(Vec<SourceInfo>, Option<String>)> {
        if !enabled {
            return Ok((Vec::new(), None));
        }

        // 检查 VFS 数据库是否可用
        let vfs_db = match &self.vfs_db {
            Some(db) => db.clone(),
            None => {
                log::debug!("[ChatV2::pipeline] VFS database not available, skipping VFS RAG");
                return Ok((Vec::new(), None));
            }
        };

        let block_id = format!("blk_{}", Uuid::new_v4());

        // 发射 start 事件
        emitter.emit_start(event_types::RAG, message_id, Some(&block_id), None, None);

        let start_time = Instant::now();

        // 创建 VFS 搜索服务
        let lance_store = match VfsLanceStore::new(vfs_db.clone()) {
            Ok(store) => Arc::new(store),
            Err(e) => {
                log::warn!("[ChatV2::pipeline] Failed to create VFS Lance store: {}", e);
                emitter.emit_error(event_types::RAG, &block_id, &e.to_string(), None);
                return Ok((Vec::new(), Some(block_id)));
            }
        };
        let search_service =
            VfsFullSearchService::new(vfs_db.clone(), lance_store, self.llm_manager.clone());

        // 构建搜索参数
        let params = VfsSearchParams {
            query: query.to_string(),
            folder_ids,
            resource_ids: None,
            resource_types,
            modality: MODALITY_TEXT.to_string(),
            top_k,
        };

        // 执行搜索（30秒超时保护，防止 LanceDB 或 reranker 挂起）
        let result = match tokio::time::timeout(
            std::time::Duration::from_secs(30),
            search_service.search_with_resource_info(query, &params, enable_reranking),
        )
        .await
        {
            Ok(r) => r,
            Err(_) => {
                log::error!(
                    "[ChatV2::pipeline] VFS RAG search timeout (30s), message={}",
                    message_id
                );
                Err(VfsError::Internal("VFS RAG search timeout".to_string()))
            }
        };

        match result {
            Ok(results) => {
                let raw_sources: Vec<SourceInfo> = results
                    .into_iter()
                    .map(|r| SourceInfo {
                        title: r.resource_title,
                        url: None,
                        snippet: Some(r.chunk_text),
                        score: Some(r.score as f32),
                        metadata: Some(json!({
                            "resourceId": r.resource_id,
                            "resourceType": r.resource_type,
                            "chunkIndex": r.chunk_index,
                            "embeddingId": r.embedding_id,
                            "sourceType": "vfs_rag",
                            "pageIndex": r.page_index,
                            "sourceId": r.source_id,
                        })),
                    })
                    .collect();

                // 应用相关性过滤
                let sources = filter_retrieval_results(
                    raw_sources,
                    RETRIEVAL_MIN_SCORE,
                    RETRIEVAL_RELATIVE_THRESHOLD,
                    top_k as usize,
                );

                let duration = start_time.elapsed().as_millis() as u64;

                // 发射 end 事件
                emitter.emit_end(
                    event_types::RAG,
                    &block_id,
                    Some(json!({
                        "sources": sources,
                        "durationMs": duration,
                        "sourceType": "vfs_rag",
                    })),
                    None,
                );

                log::debug!(
                    "[ChatV2::pipeline] VFS RAG retrieval completed: {} sources in {}ms",
                    sources.len(),
                    duration
                );

                Ok((sources, Some(block_id)))
            }
            Err(e) => {
                // 发射 error 事件
                emitter.emit_error(event_types::RAG, &block_id, &e.to_string(), None);
                log::warn!("[ChatV2::pipeline] VFS RAG retrieval error: {}", e);
                Ok((Vec::new(), Some(block_id))) // 不中断流程，但保留块 ID
            }
        }
    }

    /// 执行多模态知识库检索
    /// 返回 (sources, block_id)
    async fn execute_multimodal_retrieval(
        &self,
        query: &str,
        library_ids: &Option<Vec<String>>,
        top_k: u32,
        _enable_reranking: bool,
        enabled: bool,
        emitter: &Arc<ChatV2EventEmitter>,
        message_id: &str,
    ) -> ChatV2Result<(Vec<SourceInfo>, Option<String>)> {
        if !enabled {
            return Ok((Vec::new(), None));
        }

        // 检查多模态 RAG 是否已配置
        if !self.llm_manager.is_multimodal_rag_configured().await {
            log::debug!("[ChatV2::pipeline] Multimodal RAG not configured, skipping");
            return Ok((Vec::new(), None));
        }

        let block_id = format!("blk_{}", Uuid::new_v4());

        // 发射 start 事件
        emitter.emit_start(
            event_types::MULTIMODAL_RAG,
            message_id,
            Some(&block_id),
            None,
            None,
        );

        let start_time = Instant::now();

        // ★ 使用 VFS 多模态检索服务（2026-01 改造）
        let vfs_db = match &self.vfs_db {
            Some(db) => db.clone(),
            None => {
                log::warn!("[ChatV2::pipeline] VFS database not available");
                emitter.emit_error(
                    event_types::MULTIMODAL_RAG,
                    &block_id,
                    "VFS 数据库不可用",
                    None,
                );
                return Ok((Vec::new(), Some(block_id)));
            }
        };

        let lance_store = match VfsLanceStore::new(vfs_db.clone()) {
            Ok(ls) => Arc::new(ls),
            Err(e) => {
                log::warn!("[ChatV2::pipeline] Failed to create VFS Lance store: {}", e);
                emitter.emit_error(event_types::MULTIMODAL_RAG, &block_id, &e.to_string(), None);
                return Ok((Vec::new(), Some(block_id)));
            }
        };

        let mm_service = VfsMultimodalService::new(vfs_db, self.llm_manager.clone(), lance_store);

        // 执行 VFS 多模态检索
        let folder_ids_ref: Option<Vec<String>> = library_ids.clone();
        let result = mm_service
            .search(
                query,
                top_k as usize,
                folder_ids_ref.as_deref(),
                None, // resource_types
            )
            .await;

        match result {
            Ok(results) => {
                let sources: Vec<SourceInfo> = results
                    .into_iter()
                    .map(|r| {
                        let page_display = r.page_index + 1;
                        SourceInfo {
                            title: Some(format!("Page {} - {}", page_display, r.resource_type)),
                            url: None,
                            snippet: r.text_content,
                            score: Some(r.score),
                            metadata: Some(json!({
                                "sourceType": r.resource_type,
                                "sourceId": r.resource_id,
                                "pageIndex": r.page_index,
                                "blobHash": r.blob_hash,
                                "folderId": r.folder_id,
                            })),
                        }
                    })
                    .collect();

                let duration = start_time.elapsed().as_millis() as u64;

                // 发射 end 事件
                emitter.emit_end(
                    event_types::MULTIMODAL_RAG,
                    &block_id,
                    Some(json!({
                        "results": sources,
                        "durationMs": duration,
                    })),
                    None,
                );

                log::debug!(
                    "[ChatV2::pipeline] Multimodal retrieval completed: {} sources in {}ms",
                    sources.len(),
                    duration
                );

                Ok((sources, Some(block_id)))
            }
            Err(e) => {
                emitter.emit_error(event_types::MULTIMODAL_RAG, &block_id, &e.to_string(), None);
                log::warn!("[ChatV2::pipeline] Multimodal retrieval error: {}", e);
                Ok((Vec::new(), Some(block_id)))
            }
        }
    }

    /// 截断文本到指定长度
    pub(crate) fn truncate_text(text: &str, max_len: usize) -> String {
        if text.chars().count() <= max_len {
            text.to_string()
        } else {
            let truncated: String = text.chars().take(max_len).collect();
            format!("{}...", truncated)
        }
    }

    /// 执行记忆检索，返回 (sources, block_id)
    ///
    /// ★ 2026-01：已改用 Memory-as-VFS，通过 MemoryToolExecutor 执行
    /// 此方法仅在开启记忆检索时发射事件，实际检索由 LLM 工具完成
    async fn execute_memory_retrieval(
        &self,
        _query: &str,
        _session_id: &str,
        enabled: bool,
        emitter: &Arc<ChatV2EventEmitter>,
        message_id: &str,
    ) -> ChatV2Result<(Vec<SourceInfo>, Option<String>)> {
        if !enabled {
            return Ok((Vec::new(), None));
        }

        let block_id = format!("blk_{}", Uuid::new_v4());
        emitter.emit_start(event_types::MEMORY, message_id, Some(&block_id), None, None);

        let start_time = Instant::now();

        // ★ 2026-01：使用 Memory-as-VFS
        // 记忆检索现在通过 builtin-memory_search 工具执行，此处仅返回空结果
        // LLM 会根据需要主动调用 memory_search 工具
        let sources: Vec<SourceInfo> = Vec::new();

        let duration = start_time.elapsed().as_millis() as u64;

        emitter.emit_end(
            event_types::MEMORY,
            &block_id,
            Some(json!({
                "sources": sources,
                "durationMs": duration,
                "note": "Memory retrieval now uses builtin-memory_search tool"
            })),
            None,
        );

        log::debug!(
            "[ChatV2::pipeline] Memory retrieval placeholder completed in {}ms (use builtin-memory_search tool)",
            duration
        );

        Ok((sources, Some(block_id)))
    }

    /// 执行网络搜索
    ///
    /// 调用 web_search 模块执行网络搜索，支持多种搜索引擎。
    ///
    /// ## 参数
    /// - `query`: 搜索查询字符串
    /// - `engines`: 可选的搜索引擎列表（如 ["google_cse", "bing"]）
    /// - `enabled`: 是否启用网络搜索
    /// - `emitter`: 事件发射器
    /// - `message_id`: 消息 ID
    ///
    /// ## 返回
    /// (sources, block_id) - 搜索结果列表和块 ID
    async fn execute_web_search(
        &self,
        query: &str,
        engines: &Option<Vec<String>>,
        enabled: bool,
        emitter: &Arc<ChatV2EventEmitter>,
        message_id: &str,
    ) -> ChatV2Result<(Vec<SourceInfo>, Option<String>)> {
        if !enabled {
            return Ok((Vec::new(), None));
        }

        let block_id = format!("blk_{}", Uuid::new_v4());

        // 发射 start 事件
        emitter.emit_start(
            event_types::WEB_SEARCH,
            message_id,
            Some(&block_id),
            None,
            None,
        );

        let start_time = Instant::now();

        // 从环境变量或配置加载 web_search 配置，并应用数据库覆盖
        let mut config = match WebSearchConfig::from_env_and_file() {
            Ok(cfg) => cfg,
            Err(e) => {
                log::warn!("[ChatV2::pipeline] Failed to load web_search config: {}", e);
                // 使用默认配置继续
                WebSearchConfig::default()
            }
        };
        // 🔧 修复 #14: 统一应用数据库配置覆盖（API Keys、过滤、策略等）
        if let Some(ref db) = self.main_db {
            config.apply_db_overrides(
                |k| db.get_setting(k).ok().flatten(),
                |k| db.get_secret(k).ok().flatten(),
            );
        }

        // 构建搜索输入
        let search_input = SearchInput {
            query: query.to_string(),
            top_k: 5, // 默认返回 5 条结果
            engine: engines.as_ref().and_then(|e| e.first().cloned()),
            site: None,
            time_range: None,
            start: None,
            force_engine: None,
        };

        // 执行搜索
        let result = do_search(&config, search_input).await;
        let duration = start_time.elapsed().as_millis() as u64;

        if result.ok {
            // 将 web_search 的 citations 转换为 SourceInfo
            let sources: Vec<SourceInfo> = result
                .citations
                .unwrap_or_default()
                .into_iter()
                .map(|citation| SourceInfo {
                    title: Some(citation.file_name),
                    url: Some(citation.document_id), // document_id 存储的是 URL
                    snippet: Some(citation.chunk_text),
                    score: Some(citation.score),
                    metadata: Some(json!({
                        "sourceType": "web_search",
                        "chunkIndex": citation.chunk_index,
                        "provider": result.usage.as_ref()
                            .and_then(|u| u.get("provider"))
                            .and_then(|p| p.as_str())
                            .unwrap_or("unknown"),
                    })),
                })
                .collect();

            // 发射 end 事件
            emitter.emit_end(
                event_types::WEB_SEARCH,
                &block_id,
                Some(json!({
                    "sources": sources,
                    "durationMs": duration,
                    "usage": result.usage,
                })),
                None,
            );

            log::debug!(
                "[ChatV2::pipeline] Web search completed: {} sources in {}ms",
                sources.len(),
                duration
            );

            Ok((sources, Some(block_id)))
        } else {
            // 搜索失败，发射 error 事件
            let error_msg = result
                .error
                .map(|e| {
                    if let Some(s) = e.as_str() {
                        s.to_string()
                    } else {
                        e.to_string()
                    }
                })
                .or_else(|| result.error_details.as_ref().map(|d| d.message.clone()))
                .unwrap_or_else(|| "Unknown web search error".to_string());

            emitter.emit_error(event_types::WEB_SEARCH, &block_id, &error_msg, None);

            log::warn!(
                "[ChatV2::pipeline] Web search failed: {} ({}ms)",
                error_msg,
                duration
            );

            // 不中断流程，返回空结果但保留块 ID
            Ok((Vec::new(), Some(block_id)))
        }
    }
}
