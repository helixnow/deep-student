use super::*;

impl ChatV2Pipeline {
    /// 构建系统提示
    ///
    /// 使用 prompt_builder 模块统一格式化，采用 XML 标签分隔各部分，
    /// 统一引用格式为 `[类型-编号]`，并添加使用指引。
    /// 如果有 Canvas 笔记，也会一并注入。
    /// 若会话绑定了 workspace（或配置了全局 AGENTS.md），注入 `<project_agents_instructions>`。
    pub(crate) async fn build_system_prompt(&self, ctx: &PipelineContext) -> String {
        let canvas_note = self.build_canvas_note_info(ctx).await;

        // 读取用户画像摘要（如果 VFS 可用）
        let user_profile = self.load_user_profile(ctx).await;

        // AGENTS.md：会话绑定 workspace 根 → ~/.deep-student/AGENTS.md
        let agents_instructions = self.load_project_agents_instructions(ctx);

        prompt_builder::build_system_prompt_with_profile_and_agents(
            &ctx.options,
            &ctx.retrieved_sources,
            canvas_note,
            user_profile,
            agents_instructions,
        )
    }

    /// 解析会话绑定 workspace 根并加载 AGENTS.md 常驻指令
    ///
    /// 发现优先级由 `agents_md::load_agents_instructions` 负责：
    /// workspace `AGENTS.md` → `~/.deep-student/AGENTS.md`。
    fn load_project_agents_instructions(&self, ctx: &PipelineContext) -> Option<String> {
        let workspace_root = self.resolve_session_workspace_root(ctx);
        crate::chat_v2::agents_md::load_agents_instructions(workspace_root.as_deref())
    }

    /// 会话绑定 workspace 根：组 preferred_project_root_path → 配置的 runtime workspace → cwd
    fn resolve_session_workspace_root(&self, ctx: &PipelineContext) -> Option<std::path::PathBuf> {
        use crate::chat_v2::runtime_roots;
        use std::path::PathBuf;

        if let Some(pref) =
            runtime_roots::resolve_group_preferred_runtime_root(&self.db, &ctx.session_id)
        {
            if let Some(path) = pref
                .project_root_path
                .as_deref()
                .map(str::trim)
                .filter(|p| !p.is_empty())
            {
                let pb = PathBuf::from(path);
                if pb.is_dir() {
                    return Some(pb);
                }
            }
        }

        if let Some(ref main_db) = self.main_db {
            if let Ok(root) = runtime_roots::workspace_root(main_db) {
                if root.path.is_dir() {
                    return Some(root.path);
                }
            }
        }

        std::env::current_dir().ok()
    }

    /// 从 MemoryService 读取用户画像 + 分类摘要（双模检索的 LLM 直读模式）
    ///
    /// 受 memU dual-mode retrieval 启发：
    /// - LLM 直读模式（本方法）：将分类文件注入 system prompt，每次对话都有
    /// - 向量搜索模式（memory_search 工具）：LLM 按需主动搜索
    async fn load_user_profile(&self, ctx: &PipelineContext) -> Option<String> {
        use crate::memory::{MemoryCategoryManager, MemoryConfig, MemoryService};
        use crate::vfs::lance_store::VfsLanceStore;

        if ctx.options.memory_enabled == Some(false) {
            return None;
        }

        let vfs_db = self.vfs_db.as_ref()?;
        let mem_cfg = MemoryConfig::new(vfs_db.clone());
        // 🔧 P1-8：Err→None 不再静默，补 warn 带上下文（画像注入被跳过应可观测）
        match mem_cfg.is_privacy_mode() {
            Ok(true) => return None,
            Ok(false) => {}
            Err(e) => {
                log::warn!(
                    "[ChatV2::pipeline] load_user_profile: failed to read privacy mode (session={}): {}; skipping profile injection",
                    ctx.session_id,
                    e
                );
                return None;
            }
        }
        // 优先复用 app 托管单例（保留 Lance 连接与 ensured_tables 缓存）；
        // 无托管单例（启动降级/测试）时才按需新建。
        let lance_store = match managed_vfs_lance_store_for(vfs_db) {
            Some(store) => store,
            None => match VfsLanceStore::new(vfs_db.clone()) {
                Ok(store) => std::sync::Arc::new(store),
                Err(e) => {
                    log::warn!(
                        "[ChatV2::pipeline] load_user_profile: failed to open lance store (session={}): {}; skipping profile injection",
                        ctx.session_id,
                        e
                    );
                    return None;
                }
            },
        };
        let svc = MemoryService::new(vfs_db.clone(), lance_store, self.llm_manager.clone());

        let root_id = match svc.get_root_folder_id() {
            Ok(Some(id)) => id,
            Ok(None) => return None,
            Err(e) => {
                log::warn!(
                    "[ChatV2::pipeline] load_user_profile: failed to resolve memory root folder (session={}): {}; skipping profile injection",
                    ctx.session_id,
                    e
                );
                return None;
            }
        };

        // section 文本 + 该分类的成员 note_id 清单（用于注入在场信号回写）
        let mut sections: Vec<(String, Vec<String>)> = Vec::new();

        // 1. 加载分类摘要文件（Memory Category Layer）
        let cat_mgr = MemoryCategoryManager::new(vfs_db.clone(), self.llm_manager.clone());
        match cat_mgr.load_all_category_summaries_with_members(&root_id) {
            Ok(categories) => {
                for (cat_name, content, member_ids) in categories {
                    sections.push((format!("### {}\n{}", cat_name, content), member_ids));
                }
            }
            Err(e) => {
                // 🔧 P1-8：debug → warn（分类摘要加载失败会静默降级到旧 profile）
                log::warn!(
                    "[ChatV2::pipeline] Failed to load category summaries (session={}): {}",
                    ctx.session_id,
                    e
                );
            }
        }

        // 2. 回退：如果没有分类文件，尝试加载旧的 profile summary
        if sections.is_empty() {
            match svc.get_profile_summary() {
                Ok(Some(profile)) => return Some(profile),
                Ok(None) => return None,
                Err(e) => {
                    // 🔧 P1-8：debug → warn（画像注入被静默跳过应可观测）
                    log::warn!(
                        "[ChatV2::pipeline] Failed to load user profile summary (session={}): {}",
                        ctx.session_id,
                        e
                    );
                    return None;
                }
            }
        }

        // 3. 注入相关性排序：截断前按当轮用户消息与各分类摘要的字符 bigram
        // 重叠度重排，让相关分类优先占用 2000 字符预算；信号太弱时保持原
        // 固定顺序（行为可预测）。ctx.user_content 即当轮用户消息原文，
        // 无需改动参数链。
        let sections = rank_sections_by_relevance(sections, &ctx.user_content);

        // 防止 profile 过大吞噬上下文窗口：按完整 section 截断（不截断到中间位置）
        const PROFILE_MAX_CHARS: usize = 2000;
        let mut total_chars = 0usize;
        let mut kept_sections = Vec::new();
        // 只统计实际注入（未被截断）的分类成员，作为在场信号回写对象
        let mut injected_member_ids: Vec<String> = Vec::new();
        for (section, member_ids) in &sections {
            let section_chars = section.chars().count();
            if total_chars + section_chars > PROFILE_MAX_CHARS && !kept_sections.is_empty() {
                break;
            }
            total_chars += section_chars + 2;
            kept_sections.push(section.as_str());
            injected_member_ids.extend(member_ids.iter().cloned());
        }
        let combined = kept_sections.join("\n\n");

        // J2 修复：注入即"在场"。异步给注入的分类成员记忆回写 `_last_injected`
        // 时间戳（不阻塞 prompt 构建；同一会话每小时至多写一次），使被每轮注入、
        // LLM 从不需要主动搜索的稳定记忆不会因零命中被 evolution 降级为 `_stale`。
        if !injected_member_ids.is_empty()
            && Self::should_mark_injection_presence(&ctx.session_id)
        {
            injected_member_ids.sort();
            injected_member_ids.dedup();
            let svc_for_presence = svc.clone();
            tokio::task::spawn_blocking(move || {
                svc_for_presence.record_injection_presence(&injected_member_ids)
            });
        }

        if kept_sections.len() < sections.len() {
            Some(format!(
                "{}\n\n（用户画像已截断 {}/{} 个分类，完整信息请使用 builtin-memory_search 工具检索）",
                combined,
                kept_sections.len(),
                sections.len()
            ))
        } else {
            Some(combined)
        }
    }

    /// 注入在场信号的节流：同一会话每小时至多回写一次 `_last_injected`
    ///
    /// 进程内存中记录各会话上次回写时间，避免每轮对话都写库；
    /// 应用重启后计时器归零，最坏情况只多写一次，可接受。
    fn should_mark_injection_presence(session_id: &str) -> bool {
        use std::collections::HashMap;
        use std::sync::{Mutex, OnceLock};

        const THROTTLE_MS: i64 = 60 * 60 * 1000;
        // 清理阈值：长期不活跃的会话条目定期剔除，防止映射无界增长
        const PRUNE_MS: i64 = 24 * 60 * 60 * 1000;
        static LAST_MARK_BY_SESSION: OnceLock<Mutex<HashMap<String, i64>>> = OnceLock::new();

        let now_ms = chrono::Utc::now().timestamp_millis();
        let map = LAST_MARK_BY_SESSION.get_or_init(|| Mutex::new(HashMap::new()));
        let Ok(mut guard) = map.lock() else {
            return false;
        };
        if let Some(last) = guard.get(session_id) {
            if now_ms - last < THROTTLE_MS {
                return false;
            }
        }
        guard.retain(|_, last| now_ms - *last < PRUNE_MS);
        guard.insert(session_id.to_string(), now_ms);
        true
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
            let (text_fallback_content, _) = ctx.get_combined_user_content();

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

            // 关键修复：即使构造 multimodal_content，也保留文本 fallback。
            // 这样文本模型或错误路由到非多模态配置时，不会因为 content 为空而丢失上下文。
            (text_fallback_content, None, Some(multimodal_parts))
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

/// 打分用查询文本的最大取样字符数（过滤后计）。用户消息可能粘贴长文，
/// 打分只需开头部分即可代表主题，同时把热路径成本封顶。
const RELEVANCE_QUERY_MAX_CHARS: usize = 2000;

/// 相关性信号阈值：最高分低于该重叠 bigram 数时视为信号太弱，
/// 保持原固定顺序（避免个别偶然重叠打乱稳定的注入顺序）。
const RELEVANCE_MIN_OVERLAP: usize = 2;

/// 提取文本的字符 bigram 集合（小写、仅保留字母/数字/CJK 等字母数字类字符）
///
/// 不依赖空格分词，对中文/混排友好；标点与空白被剔除后相邻字符成对，
/// 属于廉价词法度量的可接受近似。纯同步、零分配外部依赖，可跑在每轮热路径。
fn char_bigrams(text: &str, max_chars: usize) -> std::collections::HashSet<[char; 2]> {
    let chars: Vec<char> = text
        .chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .take(max_chars)
        .collect();
    chars.windows(2).map(|w| [w[0], w[1]]).collect()
}

/// 按与当轮用户消息的词法重叠度对分类 sections 降序重排（截断前调用）
///
/// 打分 = 用户消息 bigram 集合与该分类摘要 bigram 集合的交集大小。
/// 禁止 LLM / embedding 调用（每轮热路径）。回退条件：用户消息过短
/// 产生不出 bigram，或所有分类得分都低于 `RELEVANCE_MIN_OVERLAP`——
/// 此时原样返回，维持既有固定顺序。稳定排序保证同分分类相对顺序不变。
fn rank_sections_by_relevance(
    sections: Vec<(String, Vec<String>)>,
    user_text: &str,
) -> Vec<(String, Vec<String>)> {
    if sections.len() < 2 {
        return sections;
    }
    let query_bigrams = char_bigrams(user_text, RELEVANCE_QUERY_MAX_CHARS);
    if query_bigrams.is_empty() {
        return sections;
    }
    let scores: Vec<usize> = sections
        .iter()
        .map(|(section, _)| {
            let section_bigrams = char_bigrams(section, usize::MAX);
            query_bigrams.intersection(&section_bigrams).count()
        })
        .collect();
    if scores.iter().all(|s| *s < RELEVANCE_MIN_OVERLAP) {
        return sections;
    }
    let mut scored: Vec<(usize, (String, Vec<String>))> =
        scores.into_iter().zip(sections).collect();
    // sort_by 是稳定排序：同分 section 保持原有固定顺序
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    scored.into_iter().map(|(_, section)| section).collect()
}

#[cfg(test)]
mod relevance_tests {
    use super::{char_bigrams, rank_sections_by_relevance};

    fn section(text: &str) -> (String, Vec<String>) {
        (text.to_string(), vec![])
    }

    fn titles(sections: &[(String, Vec<String>)]) -> Vec<&str> {
        sections.iter().map(|(s, _)| s.as_str()).collect()
    }

    #[test]
    fn bigrams_handle_chinese_without_whitespace_tokenization() {
        let grams = char_bigrams("我在准备高等数学考试", usize::MAX);
        assert!(grams.contains(&['高', '等']));
        assert!(grams.contains(&['数', '学']));
        // 标点/空白被剔除
        let grams2 = char_bigrams("数学，考试", usize::MAX);
        assert!(grams2.contains(&['学', '考']));
    }

    #[test]
    fn relevant_section_is_promoted_ahead_of_truncation_order() {
        let sections = vec![
            section("### 饮食偏好\n喜欢清淡饮食，不吃辣"),
            section("### 学习目标\n正在准备高等数学期末考试，重点是微积分"),
            section("### 作息习惯\n习惯晚睡，早上效率低"),
        ];
        let ranked = rank_sections_by_relevance(sections, "帮我复习高等数学的微积分部分");
        assert!(titles(&ranked)[0].contains("学习目标"));
    }

    #[test]
    fn falls_back_to_original_order_when_signal_is_weak() {
        let sections = vec![
            section("### 饮食偏好\n喜欢清淡饮食"),
            section("### 作息习惯\n习惯晚睡"),
        ];
        // 与所有分类都无重叠 → 保持原顺序
        let ranked = rank_sections_by_relevance(sections.clone(), "quantum entanglement");
        assert_eq!(titles(&ranked), titles(&sections));
        // 用户消息过短产生不出 bigram → 保持原顺序
        let ranked = rank_sections_by_relevance(sections.clone(), "嗯");
        assert_eq!(titles(&ranked), titles(&sections));
    }

    #[test]
    fn stable_order_for_tied_scores() {
        let sections = vec![
            section("### A\n数学笔记"),
            section("### B\n数学笔记"),
            section("### C\n英语笔记"),
        ];
        let ranked = rank_sections_by_relevance(sections, "数学笔记整理");
        // A/B 同分，维持原相对顺序
        assert!(titles(&ranked)[0].contains("### A"));
        assert!(titles(&ranked)[1].contains("### B"));
    }
}
