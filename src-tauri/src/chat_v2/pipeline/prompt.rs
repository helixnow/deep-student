use super::*;
use dstu_kernel::{Disposer, Slot, SlotOccupied};

// ============================================================
// step 10：域能力注入点（Canvas 笔记读取 / Insight 被动提示）
// ============================================================

/// Canvas 模式 system prompt 注入用的笔记读取口（原直接调用 `NotesManager::get_note`）。
///
/// pipeline 持有 `Option<Arc<dyn CanvasNoteSource>>`；app 注入
/// `agent_wiring::plugins::NotesCanvasSource`。为 `None` 时与原 `notes_manager = None`
/// 一致：不注入 Canvas 笔记。
pub trait CanvasNoteSource: Send + Sync {
    /// 读取笔记，返回 `(title, content_md)`；错误为原错误的 `Display` 文本（日志原样输出）。
    fn note(&self, note_id: &str) -> Result<(String, String), String>;
}

/// Insight Recall 被动提示的输入（原 `load_insight_existence_hints` 从 pipeline/ctx 读取的字段）。
pub struct InsightHintRequest<'a> {
    pub vfs_db: &'a Arc<VfsDatabase>,
    pub main_db: Option<&'a MainDatabase>,
    pub session_id: &'a str,
    pub user_message_id: &'a str,
    pub user_content: &'a str,
}

/// Insight Recall v2 阶段二被动注入（research 域实现，app 注入）。
pub trait InsightHintProvider: Send + Sync {
    /// 存在级最小披露提示；`None` = 无提示（含一切失败降级）。
    fn existence_hints(&self, request: InsightHintRequest<'_>) -> Option<String>;
}

static INSIGHT_HINT_PROVIDER: Slot<dyn InsightHintProvider> = Slot::new();

/// 注册 Insight 被动提示实现（`extensions.rs` 组合根调用；先注册者生效）。
pub fn register_insight_hint_provider(
    provider: Arc<dyn InsightHintProvider>,
) -> Result<Disposer, SlotOccupied> {
    INSIGHT_HINT_PROVIDER.provide(provider)
}

impl ChatV2Pipeline {
    /// 构建系统提示（P1-10 拆分形态）
    ///
    /// 使用 prompt_builder 模块统一格式化，采用 XML 标签分隔各部分，
    /// 统一引用格式为 `[类型-编号]`，并添加使用指引。
    /// 若会话绑定了 workspace（或配置了全局 AGENTS.md），注入 `<project_agents_instructions>`。
    ///
    /// ## P1-10：turn-volatile 迁出 system
    /// 返回拆分后的两段并把 turn-volatile 块写入 `ctx.turn_volatile_context`：
    /// - `stable_system`：跨轮字节稳定的 system（LaTeX / instructions / AGENTS /
    ///   preferences / 固定引用规则），直接交给 LLM 调用；
    /// - turn-volatile（格式 hints / 画像 / 检索 context / Canvas 笔记）随后由
    ///   compile_frozen_context 编入当前 user 消息的 `<injected_context>`，
    ///   经 V20260806 `llm_content` 列落库保证回放字节一致。
    ///
    /// 因此本方法必须在 `compile_frozen_context` **之前**调用。
    pub(crate) async fn build_system_prompt(&self, ctx: &mut PipelineContext) -> String {
        let canvas_note = self.build_canvas_note_info(ctx).await;

        // 读取用户画像摘要（如果 VFS 可用）
        let user_profile = self.load_user_profile(ctx).await;

        // AGENTS.md：会话绑定 workspace 根 → ~/.deep-student/AGENTS.md
        let agents_instructions = self.load_project_agents_instructions(ctx);

        // 🆕 Goal 模式（P0）：活跃目标摘要（仅 status=active 注入；
        // waiting_user 会在用户回复时由 send_message 入口先翻回 active）
        let active_goal = self.load_active_goal_summary(&ctx.session_id);

        // 🆕 Insight Recall v2 阶段二：被动注入（存在级最小披露）
        let insight_hints = self.load_insight_existence_hints(ctx);

        // 只向模型声明用户在设置中启用的渲染语法。
        let renderer_capabilities = self.load_renderer_capabilities();

        let parts = prompt_builder::build_system_prompt_with_profile_agents_and_renderers(
            &ctx.options,
            &ctx.retrieved_sources,
            canvas_note,
            user_profile,
            agents_instructions,
            active_goal,
            insight_hints,
            renderer_capabilities,
        );
        ctx.turn_volatile_context = parts.turn_volatile;
        parts.stable_system
    }

    pub(crate) fn load_renderer_capabilities(&self) -> prompt_builder::RendererCapabilities {
        let raw = self
            .main_db
            .as_ref()
            .and_then(|db| {
                db.get_setting(prompt_builder::RENDERER_CAPABILITIES_SETTING_KEY)
                    .ok()
            })
            .flatten();
        prompt_builder::parse_renderer_capabilities(raw.as_deref())
    }

    /// 🆕 Goal 模式（P0）：从 chat_v2 db 读取活跃目标并格式化为注入纯文本。
    ///
    /// repo 是同步连接调用——与 `load_project_agents_instructions` 经
    /// `runtime_roots` 同步读库的现有惯例一致（本函数虽在 async 上下文，
    /// 但池化连接的读操作为微秒级，不引入 spawn_blocking）。
    /// 数据方只提供纯文本；`<active_goal>` 的 XML 包裹与转义由 prompt_builder 负责。
    fn load_active_goal_summary(&self, session_id: &str) -> Option<String> {
        let conn = match self.db.get_conn() {
            Ok(conn) => conn,
            Err(e) => {
                log::warn!(
                    "[ChatV2::pipeline] load_active_goal_summary: failed to get conn (session={}): {}; skipping goal injection",
                    session_id,
                    e
                );
                return None;
            }
        };
        let goal = match ChatV2Repo::goal_get_with_conn(&conn, session_id) {
            Ok(Some(goal)) => goal,
            Ok(None) => return None,
            Err(e) => {
                log::warn!(
                    "[ChatV2::pipeline] load_active_goal_summary: failed to load goal (session={}): {}; skipping goal injection",
                    session_id,
                    e
                );
                return None;
            }
        };
        if goal.status != "active" {
            return None;
        }
        Some(crate::chat_v2::goal::format_active_goal_summary(&goal))
    }

    /// 🆕 Insight Recall v2 阶段二：被动注入（存在级最小披露）。
    ///
    /// step 10：实现属于 research 域，经 [`InsightHintProvider`] 槽位由 app 注入
    /// （`agent_wiring::plugins::InsightHintPlugin`，在 `extensions.rs` 注册）。
    /// 槽位为空等同“无灵感命中”（`None`，与原失败降级一致）。
    fn load_insight_existence_hints(&self, ctx: &PipelineContext) -> Option<String> {
        let vfs_db = self.vfs_db.as_ref()?;
        let provider = INSIGHT_HINT_PROVIDER.get()?;
        provider.existence_hints(InsightHintRequest {
            vfs_db,
            main_db: self.main_db.as_deref(),
            session_id: &ctx.session_id,
            user_message_id: &ctx.user_message_id,
            user_content: &ctx.user_content,
        })
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

        // 3. 注入顺序固定（ROUND-01-cache-prefix R1 / ROUND-02-synthesis P1）：
        // 不再按当轮用户消息重排分类。user_profile 注入在 system 前缀内，
        // 按 query 重排会让 system 每轮变化、打碎整段 prompt cache；
        // 固定顺序（分类加载顺序）保证跨轮字节稳定。

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
        if !injected_member_ids.is_empty() && Self::should_mark_injection_presence(&ctx.session_id)
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
        let note_source = self.canvas_note_source.as_ref()?;
        match note_source.note(note_id) {
            Ok((title, content_md)) => {
                let word_count = content_md.chars().count();
                log::info!(
                    "[ChatV2::pipeline] Canvas mode: loaded note '{}' ({} chars, is_long={})",
                    title,
                    word_count,
                    word_count >= 3000
                );
                Some(prompt_builder::CanvasNoteInfo::new(
                    note_id.clone(),
                    title,
                    content_md,
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
