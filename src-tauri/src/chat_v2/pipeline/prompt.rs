use super::*;

impl ChatV2Pipeline {
    /// 构建系统提示
    ///
    /// 使用 prompt_builder 模块统一格式化，采用 XML 标签分隔各部分，
    /// 统一引用格式为 `[类型-编号]`，并添加使用指引。
    /// 如果有 Canvas 笔记，也会一并注入。
    pub(crate) async fn build_system_prompt(&self, ctx: &PipelineContext) -> String {
        let canvas_note = self.build_canvas_note_info(ctx).await;

        // 读取用户画像摘要（如果 VFS 可用）
        let user_profile = self.load_user_profile().await;

        prompt_builder::build_system_prompt_with_profile(
            &ctx.options,
            &ctx.retrieved_sources,
            canvas_note,
            user_profile,
        )
    }

    /// 从 MemoryService 读取用户画像 + 分类摘要（双模检索的 LLM 直读模式）
    ///
    /// 对齐 memU 的 dual-mode retrieval：
    /// - LLM 直读模式（本方法）：将分类文件注入 system prompt，每次对话都有
    /// - 向量搜索模式（memory_search 工具）：LLM 按需主动搜索
    async fn load_user_profile(&self) -> Option<String> {
        use crate::memory::{MemoryCategoryManager, MemoryService};
        use crate::vfs::lance_store::VfsLanceStore;

        let vfs_db = self.vfs_db.as_ref()?;
        let lance_store = VfsLanceStore::new(vfs_db.clone()).ok().map(std::sync::Arc::new)?;
        let svc = MemoryService::new(
            vfs_db.clone(),
            lance_store,
            self.llm_manager.clone(),
        );

        let root_id = match svc.get_root_folder_id() {
            Ok(Some(id)) => id,
            _ => return None,
        };

        let mut sections: Vec<String> = Vec::new();

        // 1. 加载分类摘要文件（Memory Category Layer）
        let cat_mgr = MemoryCategoryManager::new(vfs_db.clone(), self.llm_manager.clone());
        match cat_mgr.load_all_category_summaries(&root_id) {
            Ok(categories) => {
                for (cat_name, content) in &categories {
                    sections.push(format!("### {}\n{}", cat_name, content));
                }
            }
            Err(e) => {
                log::debug!("[ChatV2::pipeline] Failed to load category summaries: {}", e);
            }
        }

        // 2. 回退：如果没有分类文件，尝试加载旧的 profile summary
        if sections.is_empty() {
            match svc.get_profile_summary() {
                Ok(Some(profile)) => return Some(profile),
                Ok(None) => return None,
                Err(e) => {
                    log::debug!("[ChatV2::pipeline] Failed to load user profile: {}", e);
                    return None;
                }
            }
        }

        Some(sections.join("\n\n"))
    }

    /// 构建 Canvas 笔记信息
    async fn build_canvas_note_info(
        &self,
        ctx: &PipelineContext,
    ) -> Option<prompt_builder::CanvasNoteInfo> {
        let note_id = ctx.options.canvas_note_id.as_ref()?;
        let notes_mgr = self.notes_manager.as_ref()?;
        match notes_mgr.get_note(note_id) {
            Ok(note) => {
                let word_count = note.content_md.chars().count();
                log::info!(
                    "[ChatV2::pipeline] Canvas mode: loaded note '{}' ({} chars, is_long={})",
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
                    "[ChatV2::pipeline] Canvas mode: failed to read note {}: {}",
                    note_id,
                    e
                );
                None
            }
        }
    }

    /// 构建当前用户消息（用于 LLM 调用）
    ///
    /// ★ 2025-12-10 统一改造：移除 ctx.attachments 的直接处理
    /// 所有附件现在通过 user_context_refs 传递，图片和文档内容已在前端 formatToBlocks 中处理
    ///
    /// ## 统一上下文注入系统（Prompt 8）
    /// 使用 `get_combined_user_content()` 合并上下文内容和用户输入，
    /// 将 formattedBlocks 中的文本拼接到用户内容前面，图片添加到 image_base64。
    ///
    /// ## ★ 文档25：多模态图文交替支持
    /// 当上下文引用包含图片时，使用 `get_content_blocks_ordered()` 获取有序内容块，
    /// 填充 `multimodal_content` 字段以保持图文交替顺序。
    pub(crate) fn build_current_user_message(&self, ctx: &PipelineContext) -> LegacyChatMessage {
        // ★ 文档25：检查上下文引用是否包含图片（需要图文交替）
        let has_context_images = ctx.user_context_refs.iter().any(|r| {
            r.formatted_blocks
                .iter()
                .any(|b| matches!(b, ContentBlock::Image { .. }))
        });

        // ★ 2025-12-10 统一改造：所有内容都通过 user_context_refs 传递
        // 不再从 ctx.attachments 提取图片和文档

        let (combined_content, image_base64, multimodal_content) = if has_context_images {
            // 使用 get_content_blocks_ordered() 获取图文交替的内容块
            let ordered_blocks = ctx.get_content_blocks_ordered();

            // 转换为 MultimodalContentPart 数组
            let multimodal_parts: Vec<MultimodalContentPart> = ordered_blocks
                .into_iter()
                .map(|block| match block {
                    ContentBlock::Text { text } => MultimodalContentPart::text(text),
                    ContentBlock::Image { media_type, base64 } => {
                        MultimodalContentPart::image(media_type, base64)
                    }
                })
                .collect();

            log::info!(
                "[ChatV2::pipeline] build_current_user_message: Using multimodal mode with {} parts from context refs",
                multimodal_parts.len()
            );

            // 多模态模式：content 为空字符串，图片在 multimodal_content 中
            (String::new(), None, Some(multimodal_parts))
        } else {
            // 传统模式：使用 get_combined_user_content()
            let (combined_content, context_images) = ctx.get_combined_user_content();

            let image_base64: Option<Vec<String>> = if context_images.is_empty() {
                None
            } else {
                Some(context_images)
            };

            (combined_content, image_base64, None)
        };

        // ★ 2025-12-10 统一改造：doc_attachments 不再从 ctx.attachments 构建
        // 文档内容现在通过 user_context_refs 的 formattedBlocks 传递（已由 formatToBlocks 解析）

        LegacyChatMessage {
            role: "user".to_string(),
            content: combined_content,
            timestamp: chrono::Utc::now(),
            thinking_content: None,
            thought_signature: None,
            rag_sources: None,
            memory_sources: None,
            graph_sources: None,
            web_search_sources: None,
            image_paths: None,
            image_base64,
            doc_attachments: None, // ★ 文档附件现在通过 user_context_refs 传递
            multimodal_content,    // ★ 文档25：多模态图文交替内容
            tool_call: None,
            tool_result: None,
            overrides: None,
            relations: None,
            persistent_stable_id: None,
            metadata: None,
        }
    }
}
