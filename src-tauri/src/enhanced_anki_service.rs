use crate::database::Database;
use crate::document_processing_service::DocumentProcessingService;
use crate::llm_manager::LLMManager;
use crate::models::{
    AnkiCard, AnkiDocumentGenerationRequest, AnkiGenerationOptions, AppError, DocumentTask,
    StreamedCardPayload, TaskStatus,
};
use crate::streaming_anki_service::StreamingAnkiService;
use dashmap::DashMap;
use futures::stream::{self, StreamExt};
use serde::Serialize;
use std::sync::Arc;
use std::sync::LazyLock;
use tauri::{Emitter, Window};
use tokio::task::JoinHandle;
use tracing::warn;

// 全局运行时注册表：追踪正在运行的任务与文档状态（用于硬暂停/恢复）
// 使用 DashMap 实现分片锁，按 document_id 分片，避免跨文档阻塞
#[derive(Debug, Default, Clone)]
struct DocumentRunState {
    paused: bool,
    // 标识该文档是否有"调度协程"正在运行（用于防止重复 resume/spawn）
    running: bool,
    current_task_id: Option<String>,
}

/// 文档状态注册表 - 使用 DashMap 分片锁
static DOCUMENT_STATES: LazyLock<DashMap<String, DocumentRunState>> = LazyLock::new(DashMap::new);
/// 运行句柄注册表 - 使用 DashMap 分片锁
static RUNNING_HANDLES: LazyLock<DashMap<String, JoinHandle<()>>> = LazyLock::new(DashMap::new);

pub struct EnhancedAnkiService {
    db: Arc<Database>,
    doc_processor: DocumentProcessingService,
    streaming_service: StreamingAnkiService,
}

impl EnhancedAnkiService {
    pub fn new(db: Arc<Database>, llm_manager: Arc<LLMManager>) -> Self {
        let doc_processor = DocumentProcessingService::new(db.clone());
        let streaming_service = StreamingAnkiService::new(db.clone(), llm_manager);

        Self {
            db,
            doc_processor,
            streaming_service,
        }
    }

    /// 开始文档处理 - 主要入口点
    pub async fn start_document_processing(
        &self,
        request: AnkiDocumentGenerationRequest,
        window: Window,
    ) -> Result<String, AppError> {
        self.start_document_processing_inner(request, window, None)
            .await
    }

    /// 开始文档处理（使用预分配的 document_id）
    pub async fn start_document_processing_with_id(
        &self,
        request: AnkiDocumentGenerationRequest,
        window: Window,
        pre_allocated_id: String,
    ) -> Result<String, AppError> {
        self.start_document_processing_inner(request, window, Some(pre_allocated_id))
            .await
    }

    async fn start_document_processing_inner(
        &self,
        request: AnkiDocumentGenerationRequest,
        window: Window,
        pre_allocated_id: Option<String>,
    ) -> Result<String, AppError> {
        let AnkiDocumentGenerationRequest {
            document_content,
            original_document_name,
            options,
        } = request;

        // 🔧 P0 修复 #4: 添加输入验证，防止注入攻击和资源耗尽
        // 1. 验证文档内容
        let trimmed_content = document_content.trim();
        if trimmed_content.is_empty() {
            return Err(AppError::validation("文档内容不能为空"));
        }
        const MAX_DOCUMENT_SIZE: usize = 10_000_000; // 10MB 限制
        if document_content.len() > MAX_DOCUMENT_SIZE {
            return Err(AppError::validation(format!(
                "文档内容过大，最大支持 {}MB",
                MAX_DOCUMENT_SIZE / 1_000_000
            )));
        }

        // 2. 验证文档名称（防止路径穿越攻击）
        if let Some(ref name) = original_document_name {
            if name.contains("../") || name.contains("..\\") || name.contains("./") {
                return Err(AppError::validation("文档名称包含非法字符"));
            }
            if name.len() > 255 {
                return Err(AppError::validation("文档名称过长，最大支持 255 个字符"));
            }
        }

        // 3. 验证生成选项
        if let Some(ref opts) = options {
            if opts.max_cards_per_mistake > 100 {
                return Err(AppError::validation(
                    "单次生成卡片数量过多，最大支持 100 张",
                ));
            }
        }

        let options = options.unwrap_or_else(|| AnkiGenerationOptions {
            deck_name: "默认牌组".to_string(),
            note_type: "Basic".to_string(),
            enable_images: false,
            max_cards_per_mistake: 10,
            max_cards_total: None,
            max_tokens: None,
            temperature: None,
            max_output_tokens_override: None,
            temperature_override: None,
            template_id: None,
            custom_anki_prompt: None,
            template_fields: None,
            field_extraction_rules: None,
            template_fields_by_id: None,
            field_extraction_rules_by_id: None,
            custom_requirements: None,
            segment_overlap_size: 200,
            system_prompt: None,
            template_ids: None,
            template_descriptions: None,
            enable_llm_boundary_detection: None,
        });

        // 确定文档名称
        let document_name = original_document_name
            .map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| format!("文档_{}", chrono::Utc::now().format("%Y%m%d_%H%M%S")));
        // 创建分段任务（支持预分配 document_id）
        let (document_id, tasks) = if let Some(pre_id) = pre_allocated_id {
            self.doc_processor
                .process_document_and_create_tasks_with_id(
                    pre_id,
                    document_content,
                    document_name,
                    options,
                )
                .await?
        } else {
            self.doc_processor
                .process_document_and_create_tasks(document_content, document_name, options)
                .await?
        };

        // 🔧 CardForge 2.0 修复：直接发射 StreamedCardPayload，不包装在 StreamEvent 中
        // 前端 CardAgent.handleBackendEvent 期望直接接收 { DocumentProcessingStarted: {...} } 格式
        let start_payload = StreamedCardPayload::DocumentProcessingStarted {
            document_id: document_id.clone(),
            total_segments: tasks.len() as u32,
        };

        if let Err(e) = window.emit("anki_generation_event", &start_payload) {
            warn!("发送文档处理开始事件失败: {}", e);
        }

        // 初始化文档运行状态（DashMap 无需 await，直接插入）
        DOCUMENT_STATES.insert(
            document_id.clone(),
            DocumentRunState {
                paused: false,
                running: true,
                current_task_id: None,
            },
        );

        // 异步处理所有任务
        let window_clone = window.clone();
        let streaming_service = Arc::new(self.streaming_service.clone());
        let document_id_clone = document_id.clone();

        tokio::spawn(async move {
            Self::process_all_tasks_async(
                streaming_service,
                tasks,
                window_clone,
                document_id_clone,
            )
            .await;
        });

        Ok(document_id)
    }

    /// 异步处理所有任务（支持并发执行）
    ///
    /// 并发控制策略：
    /// - 默认并发度为 5，即最多同时执行 5 个任务
    /// - 使用 futures::stream::buffer_unordered 实现有限并发
    /// - 保持暂停检查和任务状态管理功能
    async fn process_all_tasks_async(
        streaming_service: Arc<StreamingAnkiService>,
        tasks: Vec<DocumentTask>,
        window: Window,
        document_id: String,
    ) {
        // 并发度配置：可根据 API 限制调整
        const CONCURRENT_TASK_LIMIT: usize = 5;

        // 克隆 document_id 用于在闭包外部使用
        let document_id_for_check = document_id.clone();

        // 创建任务流并使用 buffer_unordered 实现有限并发
        // buffer_unordered 会同时最多执行 CONCURRENT_TASK_LIMIT 个 Future
        let task_stream = stream::iter(tasks)
            .map(|task| {
                let service = streaming_service.clone();
                let window_clone = window.clone();
                let document_id_clone = document_id.clone();
                let task_id = task.id.clone();

                async move {
                    // 暂停检查：如果文档已暂停，跳过任务
                    if let Some(state) = DOCUMENT_STATES.get(&document_id_clone) {
                        if state.paused {
                            return (task_id.clone(), false); // 返回 (task_id, 是否执行)
                        }
                    }

                    // 记录当前运行任务ID（仅供调试，并发下可能有多个）
                    DOCUMENT_STATES
                        .entry(document_id_clone.clone())
                        .or_default()
                        .current_task_id = Some(task_id.clone());

                    // 创建任务处理句柄
                    let handle = tokio::spawn({
                        let service = service.clone();
                        let window_clone = window_clone.clone();
                        async move {
                            if let Err(e) = service
                                .process_task_and_generate_cards_stream(task, window_clone)
                                .await
                            {
                                warn!("任务处理失败: {}", e);
                            }
                        }
                    });

                    // 记录运行句柄，便于硬暂停时直接中止
                    RUNNING_HANDLES.insert(task_id.clone(), handle);

                    // 短暂让出以便流任务完成取消通道注册，降低竞态窗口
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;

                    // 等待任务完成
                    let owned_handle_opt = RUNNING_HANDLES.remove(&task_id).map(|(_, h)| h);
                    if let Some(handle) = owned_handle_opt {
                        let _ = handle.await;
                    }

                    // 清空当前任务ID（任务完成或被取消后）
                    // 注意：并发场景下这里可能清空其他任务的ID，但不影响核心功能
                    if let Some(mut entry) = DOCUMENT_STATES.get_mut(&document_id_clone) {
                        if entry.current_task_id.as_ref() == Some(&task_id) {
                            entry.current_task_id = None;
                        }
                    }

                    (task_id, true) // 返回 (task_id, 已执行)
                }
            })
            .buffer_unordered(CONCURRENT_TASK_LIMIT);

        // 将 task_stream 固定到栈上，避免借用检查问题
        tokio::pin!(task_stream);

        // 执行所有任务并收集结果
        let mut completed_count = 0;
        let mut skipped_count = 0;

        while let Some((task_id, executed)) = task_stream.next().await {
            if executed {
                completed_count += 1;
            } else {
                skipped_count += 1;
                warn!("任务 {} 因文档暂停被跳过", task_id);
            }

            // 再次检查暂停状态，如果被暂停则提前终止流
            if let Some(state) = DOCUMENT_STATES.get(&document_id_for_check) {
                if state.paused {
                    warn!(
                        "文档 {} 被暂停，已完成 {} 个任务，跳过 {} 个任务",
                        document_id_for_check, completed_count, skipped_count
                    );
                    break;
                }
            }
        }

        // 在宣告完成前，尝试构建并执行"统一重试"任务（若存在错误/截断）
        match streaming_service
            .build_retry_task_for_document(&document_id_for_check)
            .await
        {
            Ok(Some(retry_task)) => {
                // 若文档被暂停，跳过重试任务
                let paused = DOCUMENT_STATES
                    .get(&document_id_for_check)
                    .map(|s| s.paused)
                    .unwrap_or(false);
                if !paused {
                    // 更新当前运行任务ID
                    DOCUMENT_STATES
                        .entry(document_id_for_check.clone())
                        .or_default()
                        .current_task_id = Some(retry_task.id.clone());

                    let service = streaming_service.clone();
                    let window_clone = window.clone();
                    let task_id_for_map = retry_task.id.clone();

                    let handle = tokio::spawn(async move {
                        if let Err(e) = service
                            .process_task_and_generate_cards_stream(retry_task, window_clone)
                            .await
                        {
                            warn!("统一重试任务处理失败: {}", e);
                        }
                    });

                    // 记录运行句柄
                    RUNNING_HANDLES.insert(task_id_for_map.clone(), handle);
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                    let owned_handle_opt = RUNNING_HANDLES.remove(&task_id_for_map).map(|(_, h)| h);
                    if let Some(handle) = owned_handle_opt {
                        let _ = handle.await;
                    }

                    // 清空当前任务ID
                    if let Some(mut entry) = DOCUMENT_STATES.get_mut(&document_id_for_check) {
                        entry.current_task_id = None;
                    }
                }
            }
            Ok(None) => { /* 无需重试 */ }
            Err(e) => {
                warn!("构建统一重试任务失败: {}", e);
            }
        }

        // 调度完成，标记 running=false，如未暂停则清理状态
        if let Some(mut entry) = DOCUMENT_STATES.get_mut(&document_id_for_check) {
            entry.running = false;
            if !entry.paused {
                drop(entry); // 释放引用后再删除
                DOCUMENT_STATES.remove(&document_id_for_check);
            }
        }

        // 若未暂停，发送文档处理完成事件
        let should_emit_completed = DOCUMENT_STATES
            .get(&document_id_for_check)
            .map(|s| !s.paused)
            .unwrap_or(true);
        if should_emit_completed {
            // 🔧 CardForge 2.0 修复：直接发射 StreamedCardPayload
            let complete_payload = StreamedCardPayload::DocumentProcessingCompleted {
                document_id: document_id_for_check,
            };
            if let Err(e) = window.emit("anki_generation_event", &complete_payload) {
                warn!("发送文档处理完成事件失败: {}", e);
            }
        }
    }

    /// 硬暂停文档处理
    pub async fn pause_document_processing(
        &self,
        document_id: String,
        window: Window,
    ) -> Result<(), AppError> {
        // 标记文档为暂停
        let current_task_id = {
            let mut entry = DOCUMENT_STATES.entry(document_id.clone()).or_default();
            entry.paused = true;
            // 暂停后，允许后续 resume 重新启动调度
            entry.running = false;
            entry.current_task_id.clone()
        };

        let doc_tasks = match self.doc_processor.get_document_tasks(&document_id) {
            Ok(tasks) => tasks,
            Err(err) => {
                warn!("获取文档任务失败，暂停将尝试仅中止当前任务: {}", err);
                Vec::new()
            }
        };
        let mut running_tasks: Vec<DocumentTask> = doc_tasks
            .iter()
            .cloned()
            .filter(|t| matches!(t.status, TaskStatus::Processing | TaskStatus::Streaming))
            .collect();

        if let Some(task_id) = current_task_id.clone() {
            if !running_tasks.iter().any(|t| t.id == task_id) {
                if let Ok(task) = self.doc_processor.get_task(&task_id) {
                    running_tasks.push(task);
                }
            }
        }

        if !running_tasks.is_empty() {
            for task in running_tasks {
                let task_id = task.id.clone();
                // 通过流服务发出取消信号（硬暂停：断开流）
                if let Err(e) = self
                    .streaming_service
                    .cancel_streaming(task_id.clone())
                    .await
                {
                    warn!("取消流失败: {}，尝试直接中止任务句柄", e);
                    // 兜底：直接中止运行句柄（若存在）
                    if let Some((_, h)) = RUNNING_HANDLES.remove(&task_id) {
                        h.abort();
                    }
                }

                // 更新状态
                self.doc_processor
                    .update_task_status(&task_id, TaskStatus::Paused, None)?;

                // 派发状态事件
                // 🔧 CardForge 2.0 修复：直接发射 StreamedCardPayload
                let payload = StreamedCardPayload::TaskStatusUpdate {
                    task_id: task_id.clone(),
                    status: TaskStatus::Paused,
                    message: None,
                    segment_index: Some(task.segment_index),
                    document_id: Some(task.document_id.clone()),
                };
                if let Err(e) = window.emit("anki_generation_event", &payload) {
                    warn!("发送任务状态更新事件失败: {}", e);
                }
            }
        } else {
            // 无运行任务：将第一个待处理任务置为 Paused 以便前端感知
            if let Some(t) = doc_tasks
                .into_iter()
                .find(|t| matches!(t.status, TaskStatus::Pending))
            {
                self.doc_processor
                    .update_task_status(&t.id, TaskStatus::Paused, None)?;
                // 🔧 CardForge 2.0 修复：直接发射 StreamedCardPayload
                let payload = StreamedCardPayload::TaskStatusUpdate {
                    task_id: t.id.clone(),
                    status: TaskStatus::Paused,
                    message: None,
                    segment_index: Some(t.segment_index),
                    document_id: Some(t.document_id.clone()),
                };
                if let Err(e) = window.emit("anki_generation_event", &payload) {
                    warn!("发送任务状态更新事件失败: {}", e);
                }
            }
        }

        // 🔧 CardForge 2.0 修复：直接发射 StreamedCardPayload
        let pause_payload = StreamedCardPayload::DocumentProcessingPaused {
            document_id: document_id.clone(),
        };
        if let Err(e) = window.emit("anki_generation_event", &pause_payload) {
            warn!("发送文档暂停事件失败: {}", e);
        }

        Ok(())
    }

    /// 恢复文档处理：继续 Paused 或 Pending 任务
    pub async fn resume_document_processing(
        &self,
        document_id: String,
        window: Window,
    ) -> Result<(), AppError> {
        // 防重入：若该文档已在运行，则直接返回
        {
            let mut entry = DOCUMENT_STATES.entry(document_id.clone()).or_default();
            if entry.running {
                // 已有调度进行中，仅确保不处于暂停态
                entry.paused = false;
                return Ok(());
            }
            // 将状态切换为运行中
            entry.paused = false;
            entry.running = true;
        }

        let mut remaining: Vec<DocumentTask> = self
            .doc_processor
            .get_document_tasks(&document_id)
            .map_err(|e| {
                if let Some(mut entry) = DOCUMENT_STATES.get_mut(&document_id) {
                    entry.running = false;
                    if !entry.paused {
                        drop(entry);
                        DOCUMENT_STATES.remove(&document_id);
                    }
                }
                e
            })?
            .into_iter()
            .filter(|t| matches!(t.status, TaskStatus::Paused | TaskStatus::Pending))
            .collect();
        remaining.sort_by_key(|t| t.segment_index);

        if remaining.is_empty() {
            // 无需继续执行，标记运行结束并直接宣告完成，防止前端卡住
            if let Some(mut entry) = DOCUMENT_STATES.get_mut(&document_id) {
                entry.running = false;
                if !entry.paused {
                    drop(entry);
                    DOCUMENT_STATES.remove(&document_id);
                }
            }
            // 🔧 CardForge 2.0 修复：直接发射 StreamedCardPayload
            let complete_payload = StreamedCardPayload::DocumentProcessingCompleted {
                document_id: document_id.clone(),
            };
            if let Err(e) = window.emit("anki_generation_event", &complete_payload) {
                warn!("发送文档处理完成事件失败: {}", e);
            }
            return Ok(());
        }

        let window_clone = window.clone();
        let streaming_service = Arc::new(self.streaming_service.clone());
        tokio::spawn(async move {
            Self::process_all_tasks_async(streaming_service, remaining, window_clone, document_id)
                .await;
        });

        Ok(())
    }

    /// 手动触发单个任务处理
    pub async fn trigger_task_processing(
        &self,
        task_id: String,
        window: Window,
    ) -> Result<(), AppError> {
        let task = self.doc_processor.get_task(&task_id)?;

        if !matches!(
            task.status,
            TaskStatus::Pending | TaskStatus::Failed | TaskStatus::Truncated
        ) {
            return Err(AppError::validation("任务状态不是待处理"));
        }

        let streaming_service = Arc::new(self.streaming_service.clone());
        let window_clone = window.clone();

        tokio::spawn(async move {
            if let Err(e) = streaming_service
                .process_task_and_generate_cards_stream(task, window_clone)
                .await
            {
                tracing::warn!("任务处理失败: {}", e);
            }
        });

        Ok(())
    }

    /// 获取文档任务列表
    pub fn get_document_tasks(&self, document_id: String) -> Result<Vec<DocumentTask>, AppError> {
        self.doc_processor.get_document_tasks(&document_id)
    }

    /// 获取任务的卡片列表
    pub fn get_task_cards(&self, task_id: String) -> Result<Vec<AnkiCard>, AppError> {
        self.db
            .get_cards_for_task(&task_id)
            .map_err(|e| AppError::database(format!("获取任务卡片失败: {}", e)))
    }

    /// 更新卡片
    pub fn update_anki_card(&self, card: AnkiCard) -> Result<(), AppError> {
        self.db
            .update_anki_card(&card)
            .map_err(|e| AppError::database(format!("更新卡片失败: {}", e)))
    }

    /// 删除卡片
    pub fn delete_anki_card(&self, card_id: String) -> Result<(), AppError> {
        self.db
            .delete_anki_card(&card_id)
            .map_err(|e| AppError::database(format!("删除卡片失败: {}", e)))
    }

    /// 删除任务
    pub fn delete_document_task(&self, task_id: String) -> Result<(), AppError> {
        self.db
            .delete_document_task(&task_id)
            .map_err(|e| AppError::database(format!("删除任务失败: {}", e)))
    }

    /// 删除文档会话
    pub async fn delete_document_session(&self, document_id: String) -> Result<(), AppError> {
        if let Some(mut entry) = DOCUMENT_STATES.get_mut(&document_id) {
            entry.paused = true;
            entry.running = false;
        }

        if let Ok(tasks) = self.doc_processor.get_document_tasks(&document_id) {
            for task in tasks
                .into_iter()
                .filter(|t| matches!(t.status, TaskStatus::Processing | TaskStatus::Streaming))
            {
                if let Err(e) = self
                    .streaming_service
                    .cancel_streaming(task.id.clone())
                    .await
                {
                    warn!("取消流失败: {}，尝试直接中止任务句柄", e);
                    if let Some((_, h)) = RUNNING_HANDLES.remove(&task.id) {
                        h.abort();
                    }
                }
            }
        }

        self.db
            .delete_document_session(&document_id)
            .map_err(|e| AppError::database(format!("删除文档会话失败: {}", e)))?;

        DOCUMENT_STATES.remove(&document_id);
        Ok(())
    }

    /// 导出选定内容为APKG
    pub async fn export_apkg_for_selection(
        &self,
        document_id: Option<String>,
        task_ids: Option<Vec<String>>,
        card_ids: Option<Vec<String>>,
        options: AnkiGenerationOptions,
    ) -> Result<String, AppError> {
        // 根据选择获取卡片
        let cards = if let Some(ids) = card_ids {
            self.db
                .get_cards_by_ids(&ids)
                .map_err(|e| AppError::database(format!("获取指定卡片失败: {}", e)))?
        } else if let Some(task_ids) = task_ids {
            let mut all_cards = Vec::new();
            for task_id in task_ids {
                let mut task_cards = self
                    .db
                    .get_cards_for_task(&task_id)
                    .map_err(|e| AppError::database(format!("获取任务卡片失败: {}", e)))?;
                all_cards.append(&mut task_cards);
            }
            all_cards
        } else if let Some(doc_id) = document_id.as_ref() {
            self.db
                .get_cards_for_document(doc_id)
                .map_err(|e| AppError::database(format!("获取文档卡片失败: {}", e)))?
        } else {
            return Err(AppError::validation("必须指定要导出的内容"));
        };

        // 过滤掉错误卡片（除非用户明确要求包含）
        let valid_cards: Vec<AnkiCard> = cards
            .into_iter()
            .filter(|card| !card.is_error_card)
            .collect();

        if valid_cards.is_empty() {
            return Err(AppError::validation("没有有效的卡片可以导出"));
        }

        // 调用现有的APKG导出服务
        // 注意：这里需要将enhanced AnkiCard转换为原始AnkiCard格式
        let simple_cards: Vec<crate::models::AnkiCard> = valid_cards
            .into_iter()
            .map(|card| crate::models::AnkiCard {
                front: card.front,
                back: card.back,
                text: card.text,
                tags: card.tags,
                images: card.images,
                id: card.id,
                task_id: card.task_id,
                is_error_card: card.is_error_card,
                error_content: card.error_content,
                created_at: card.created_at,
                updated_at: card.updated_at,
                extra_fields: card.extra_fields,
                template_id: card.template_id,
            })
            .collect();

        // 使用现有的导出服务，支持模板
        let output_path =
            std::env::temp_dir().join(format!("anki_export_{}.apkg", uuid::Uuid::new_v4()));

        // 获取模板配置（如果指定了模板）
        let template_config = if let Some(template_id) = &options.template_id {
            match crate::commands::get_template_config(template_id, &self.db) {
                Ok(config) => Some(config),
                Err(e) => {
                    // 记录详细错误信息
                    warn!(
                        "获取模板配置失败 - 模板ID: {}, 错误: {}，将使用默认模板继续导出",
                        template_id, e
                    );
                    None
                }
            }
        } else {
            None
        };

        crate::apkg_exporter_service::export_cards_to_apkg_with_template(
            simple_cards,
            options.deck_name,
            options.note_type,
            output_path.clone(),
            template_config,
        )
        .await
        .map_err(|e| AppError::file_system(format!("导出APKG失败: {}", e)))?;

        if let Some(doc_id) = document_id.as_ref() {
            DOCUMENT_STATES.remove(doc_id);
        }

        Ok(output_path.to_string_lossy().to_string())
    }

    /// 查询文档状态（仅用于调试/前端状态校验）
    pub async fn get_document_state(&self, document_id: String) -> DocumentStateDto {
        let state = DOCUMENT_STATES.get(&document_id).map(|r| r.clone());
        match state {
            Some(s) => DocumentStateDto {
                paused: s.paused,
                current_task_id: s.current_task_id,
            },
            None => DocumentStateDto {
                paused: false,
                current_task_id: None,
            },
        }
    }

    /// 获取文档任务计数（冒烟测试/调试用途）
    pub async fn get_document_task_counts(&self, document_id: String) -> DocumentTaskCountsDto {
        let mut counts = DocumentTaskCountsDto::default();
        if let Ok(tasks) = self.doc_processor.get_document_tasks(&document_id) {
            counts.total = tasks.len() as u32;
            for t in tasks {
                match t.status {
                    TaskStatus::Pending => counts.pending += 1,
                    TaskStatus::Processing => counts.processing += 1,
                    TaskStatus::Streaming => counts.streaming += 1,
                    TaskStatus::Paused => counts.paused += 1,
                    TaskStatus::Completed => counts.completed += 1,
                    TaskStatus::Failed => counts.failed += 1,
                    TaskStatus::Truncated => counts.truncated += 1,
                    TaskStatus::Cancelled => counts.cancelled += 1,
                }
            }
        }
        counts
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct DocumentStateDto {
    pub paused: bool,
    pub current_task_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct DocumentTaskCountsDto {
    pub pending: u32,
    pub processing: u32,
    pub streaming: u32,
    pub paused: u32,
    pub completed: u32,
    pub failed: u32,
    pub truncated: u32,
    pub cancelled: u32,
    pub total: u32,
}

// -----------------------
// Minimal test helpers and tests (no network)
// -----------------------
#[cfg(test)]
mod tests {
    use super::*;
    use crate::document_processing_service::DocumentProcessingService;
    use crate::file_manager::FileManager;
    use crate::models::AnkiGenerationOptions;
    use std::sync::Arc;

    impl EnhancedAnkiService {
        /// Test-only: pause without emitting events (for offline tests)
        pub async fn __test_pause_no_emit(&self, document_id: String) -> Result<(), AppError> {
            // mark paused
            DOCUMENT_STATES
                .entry(document_id.clone())
                .or_default()
                .paused = true;
            // find first incomplete task and mark paused
            if let Ok(doc_tasks) = self.doc_processor.get_document_tasks(&document_id) {
                if let Some(t) = doc_tasks.into_iter().find(|t| {
                    matches!(
                        t.status,
                        TaskStatus::Processing | TaskStatus::Streaming | TaskStatus::Pending
                    )
                }) {
                    self.doc_processor
                        .update_task_status(&t.id, TaskStatus::Paused, None)?;
                }
            }
            Ok(())
        }

        /// Test-only: resume without spawning streaming (for offline tests)
        pub async fn __test_resume_no_emit(&self, document_id: String) -> Result<(), AppError> {
            // clear paused flag
            DOCUMENT_STATES
                .entry(document_id.clone())
                .or_default()
                .paused = false;
            // set paused tasks back to Pending
            if let Ok(tasks) = self.doc_processor.get_document_tasks(&document_id) {
                for t in tasks.into_iter() {
                    if matches!(t.status, TaskStatus::Paused) {
                        self.doc_processor
                            .update_task_status(&t.id, TaskStatus::Pending, None)?;
                    }
                }
            }
            Ok(())
        }
    }

    #[tokio::test]
    async fn test_pause_marks_first_task_paused_without_streaming() {
        // temp dir
        let tmp_dir = std::env::temp_dir().join(format!("dstu_test_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp_dir).unwrap();

        // file manager + db
        let fm = Arc::new(FileManager::new(tmp_dir.clone()).expect("fm"));
        let db_path = tmp_dir.join("test.db");
        let db = Arc::new(crate::database::Database::new(&db_path).expect("db"));
        let llm =
            Arc::new(crate::llm_manager::LLMManager::new(db.clone(), fm.clone()).expect("llm"));
        let svc = EnhancedAnkiService::new(db.clone(), llm.clone());
        let dps = DocumentProcessingService::new(db.clone());

        // create tasks without starting streaming
        let options = AnkiGenerationOptions {
            deck_name: "Default".to_string(),
            note_type: "Basic".to_string(),
            enable_images: false,
            max_cards_per_mistake: 2,
            max_cards_total: None,
            max_tokens: None,
            temperature: None,
            max_output_tokens_override: None,
            temperature_override: None,
            template_id: None,
            custom_anki_prompt: None,
            template_fields: None,
            field_extraction_rules: None,
            template_fields_by_id: None,
            field_extraction_rules_by_id: None,
            custom_requirements: None,
            segment_overlap_size: 200,
            system_prompt: None,
            template_ids: None,
            template_descriptions: None,
            enable_llm_boundary_detection: None,
        };
        let (doc_id, _tasks) = dps
            .process_document_and_create_tasks(
                "这是一段用于测试的文档内容。".to_string(),
                "测试文档".to_string(),
                options,
            )
            .await
            .expect("create tasks");

        // ensure state initialized
        DOCUMENT_STATES.insert(
            doc_id.clone(),
            super::DocumentRunState {
                paused: false,
                running: false,
                current_task_id: None,
            },
        );

        // invoke pause (no emit)
        svc.__test_pause_no_emit(doc_id.clone())
            .await
            .expect("pause");

        // verify one task paused
        let tasks = dps.get_document_tasks(&doc_id).expect("tasks");
        assert!(
            tasks.iter().any(|t| matches!(t.status, TaskStatus::Paused)),
            "no task paused"
        );
    }

    #[tokio::test]
    async fn test_resume_unpauses_document_and_pending_exists() {
        // temp dir
        let tmp_dir =
            std::env::temp_dir().join(format!("dstu_test_resume_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp_dir).unwrap();

        let fm = Arc::new(FileManager::new(tmp_dir.clone()).expect("fm"));
        let db_path = tmp_dir.join("test.db");
        let db = Arc::new(crate::database::Database::new(&db_path).expect("db"));
        let llm =
            Arc::new(crate::llm_manager::LLMManager::new(db.clone(), fm.clone()).expect("llm"));
        let svc = EnhancedAnkiService::new(db.clone(), llm.clone());
        let dps = DocumentProcessingService::new(db.clone());

        let options = AnkiGenerationOptions {
            deck_name: "Default".to_string(),
            note_type: "Basic".to_string(),
            enable_images: false,
            max_cards_per_mistake: 2,
            max_cards_total: None,
            max_tokens: None,
            temperature: None,
            max_output_tokens_override: None,
            temperature_override: None,
            template_id: None,
            custom_anki_prompt: None,
            template_fields: None,
            field_extraction_rules: None,
            template_fields_by_id: None,
            field_extraction_rules_by_id: None,
            custom_requirements: None,
            segment_overlap_size: 200,
            system_prompt: None,
            template_ids: None,
            template_descriptions: None,
            enable_llm_boundary_detection: None,
        };
        let (doc_id, _tasks) = dps
            .process_document_and_create_tasks(
                "resume test content".to_string(),
                "测试文档2".to_string(),
                options,
            )
            .await
            .expect("create tasks");

        // init state and pause one
        DOCUMENT_STATES.insert(
            doc_id.clone(),
            super::DocumentRunState {
                paused: false,
                running: false,
                current_task_id: None,
            },
        );
        svc.__test_pause_no_emit(doc_id.clone())
            .await
            .expect("pause");

        // resume
        svc.__test_resume_no_emit(doc_id.clone())
            .await
            .expect("resume");

        // check state flag cleared
        let flag = DOCUMENT_STATES
            .get(&doc_id)
            .map(|s| s.paused)
            .unwrap_or(false);
        assert!(!flag, "document paused flag not cleared");

        // check at least one pending exists (previous paused -> pending)
        let tasks = dps.get_document_tasks(&doc_id).expect("tasks");
        assert!(
            tasks
                .iter()
                .any(|t| matches!(t.status, TaskStatus::Pending)),
            "no pending after resume"
        );
        assert!(
            tasks
                .iter()
                .all(|t| !matches!(t.status, TaskStatus::Paused)),
            "still paused tasks after resume"
        );
    }
}
