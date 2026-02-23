//! 旧版 chat_messages 迁移到 Chat V2 的核心实现

use chrono::{DateTime, Utc};
use rusqlite::Connection;
use serde_json::Value;
use std::collections::HashMap;
use tauri::{Emitter, Window};

use crate::chat_v2::error::ChatV2Error;
use crate::chat_v2::types::{block_status, block_types};

use super::types::{
    MigrationCheckResult, MigrationEvent, MigrationEventType, MigrationProgress, MigrationReport,
    MigrationStatus, MigrationStep,
};

/// 记录并跳过迭代中的错误，避免静默丢弃
fn log_and_skip_err<T, E: std::fmt::Display>(result: std::result::Result<T, E>) -> Option<T> {
    match result {
        Ok(v) => Some(v),
        Err(e) => {
            tracing::warn!("[LegacyMigration] Row parse error (skipped): {}", e);
            None
        }
    }
}

/// 迁移事件通道名
pub const MIGRATION_EVENT_CHANNEL: &str = "chat_v2_migration";

/// 旧版消息结构（从 chat_messages 表读取）
#[derive(Debug, Clone)]
struct LegacyMessage {
    id: i64,
    mistake_id: String,
    role: String,
    content: String,
    timestamp: String,
    thinking_content: Option<String>,
    rag_sources: Option<String>,
    memory_sources: Option<String>,
    graph_sources: Option<String>,
    web_search_sources: Option<String>,
    image_paths: Option<String>,
    image_base64: Option<String>,
    doc_attachments: Option<String>,
    tool_call: Option<String>,
    tool_result: Option<String>,
    stable_id: Option<String>,
    metadata: Option<String>,
}

/// 标题最大长度
const TITLE_MAX_LENGTH: usize = 50;

/// 迁移执行器
pub struct MigrationExecutor {
    window: Option<Window>,
    progress: MigrationProgress,
    report: MigrationReport,
}

impl MigrationExecutor {
    pub fn new(window: Option<Window>) -> Self {
        Self {
            window,
            progress: MigrationProgress::default(),
            report: MigrationReport::default(),
        }
    }

    /// 发送迁移事件到前端
    fn emit_event(&self, event_type: MigrationEventType, message: &str) {
        if let Some(ref window) = self.window {
            let event = MigrationEvent {
                event_type,
                progress: self.progress.clone(),
                message: message.to_string(),
            };
            if let Err(e) = window.emit(MIGRATION_EVENT_CHANNEL, &event) {
                tracing::warn!("[Migration] 发送事件失败: {}", e);
            }
        }
    }

    /// 更新进度并发送事件
    fn update_progress(&mut self, step: MigrationStep, message: &str) {
        self.progress.current_step = step;
        self.progress.update_percent();
        self.emit_event(MigrationEventType::Progress, message);
    }

    /// 执行迁移
    pub fn execute(
        &mut self,
        data_conn: &Connection,
        chat_v2_conn: &Connection,
    ) -> Result<MigrationReport, ChatV2Error> {
        self.report.started_at = Utc::now().timestamp_millis();
        self.progress.status = MigrationStatus::InProgress;
        self.emit_event(MigrationEventType::Started, "开始迁移旧版对话数据");

        let result = self.execute_internal(data_conn, chat_v2_conn);

        self.report.ended_at = Utc::now().timestamp_millis();
        self.report.duration_ms = self.report.ended_at - self.report.started_at;

        match result {
            Ok(_) => {
                self.report.status = MigrationStatus::Completed;
                self.progress.status = MigrationStatus::Completed;
                self.progress.percent = 100;
                self.emit_event(MigrationEventType::Completed, "迁移完成");
            }
            Err(ref e) => {
                self.report.status = MigrationStatus::Failed;
                self.progress.status = MigrationStatus::Failed;
                self.progress.error = Some(e.to_string());
                self.report.errors.push(e.to_string());
                self.emit_event(MigrationEventType::Failed, &format!("迁移失败: {}", e));
            }
        }

        Ok(self.report.clone())
    }

    fn execute_internal(
        &mut self,
        data_conn: &Connection,
        chat_v2_conn: &Connection,
    ) -> Result<(), ChatV2Error> {
        // 步骤 1: 检查旧数据
        self.update_progress(MigrationStep::CheckLegacyData, "正在检查旧版数据...");
        let legacy_messages = self.load_legacy_messages(data_conn)?;

        if legacy_messages.is_empty() {
            tracing::info!("[Migration] 没有需要迁移的消息");
            return Ok(());
        }

        self.progress.total_messages = legacy_messages.len();
        tracing::info!("[Migration] 发现 {} 条待迁移消息", legacy_messages.len());

        // 步骤 2: 按 mistake_id 分组
        self.update_progress(MigrationStep::GroupByMistakeId, "正在分组消息...");
        let grouped = self.group_by_mistake_id(&legacy_messages);
        self.progress.total_sessions = grouped.len();
        tracing::info!("[Migration] 分组为 {} 个会话", grouped.len());

        // 步骤 3-6: 逐个会话迁移（每个会话使用事务保护）
        for (mistake_id, messages) in grouped {
            self.progress.current_mistake_id = Some(mistake_id.clone());

            // 创建会话
            self.update_progress(
                MigrationStep::CreateSession,
                &format!("正在创建会话: {}", mistake_id),
            );

            // P0 修复：为每个会话的迁移使用事务保护
            // 确保会话创建 + 所有消息迁移是原子的，避免中途失败产生不一致数据
            chat_v2_conn
                .execute("BEGIN IMMEDIATE", [])
                .map_err(|e| ChatV2Error::Database(format!("迁移事务开始失败: {}", e)))?;

            let session_result = (|| -> Result<(String, Vec<i64>), ChatV2Error> {
                // ★ 获取有意义的标题
                let title = self.get_session_title(data_conn, &mistake_id, &messages);
                let session_id = self.create_session(chat_v2_conn, &mistake_id, &title)?;
                self.progress.created_sessions += 1;
                self.report.sessions_created += 1;

                let mut migrated_msg_ids: Vec<i64> = Vec::new();

                // 迁移消息
                for msg in &messages {
                    self.update_progress(
                        MigrationStep::MigrateMessages,
                        &format!(
                            "正在迁移消息 {}/{}",
                            self.progress.migrated_messages + 1,
                            self.progress.total_messages
                        ),
                    );

                    let blocks_count = self.migrate_message(chat_v2_conn, &session_id, msg)?;
                    self.report.blocks_created += blocks_count;
                    self.report.messages_migrated += 1;
                    self.progress.migrated_messages += 1;
                    migrated_msg_ids.push(msg.id);
                }
                Ok((session_id, migrated_msg_ids))
            })();

            match session_result {
                Ok((session_id, migrated_msg_ids)) => {
                    // 先提交 chat_v2.db 事务
                    chat_v2_conn.execute("COMMIT", []).map_err(|e| {
                        ChatV2Error::Database(format!("迁移事务提交失败: {}", e))
                    })?;

                    // 事务提交成功后，再标记 data.db 中的消息为已迁移
                    // 这样即使标记失败，V2 数据完整，重试时最多产生重复但不会丢数据
                    for msg_id in &migrated_msg_ids {
                        if let Err(e) =
                            self.mark_message_migrated(data_conn, *msg_id, &session_id)
                        {
                            tracing::warn!(
                                "[Migration] 标记消息 {} 已迁移失败: {:?}（V2 数据已保存）",
                                msg_id, e
                            );
                        }
                    }
                }
                Err(e) => {
                    // 回滚 chat_v2.db 事务
                    if let Err(rollback_err) = chat_v2_conn.execute("ROLLBACK", []) {
                        tracing::error!(
                            "[Migration] 回滚迁移事务失败: {} (原始错误: {:?})",
                            rollback_err, e
                        );
                    }
                    tracing::error!(
                        "[Migration] 会话 {} 迁移失败并已回滚: {:?}",
                        mistake_id, e
                    );
                    self.report.errors.push(format!(
                        "会话 {} 迁移失败: {}",
                        mistake_id, e
                    ));
                    // 继续迁移其他会话，不中断整个流程
                    continue;
                }
            }
        }

        // 步骤 7: 完成
        self.update_progress(MigrationStep::Finished, "迁移完成");

        Ok(())
    }

    /// 加载未迁移的旧版消息
    fn load_legacy_messages(&self, conn: &Connection) -> Result<Vec<LegacyMessage>, ChatV2Error> {
        // 检查表是否存在 migrated_to_v2 列
        let has_migrated_column = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('chat_messages') WHERE name = 'migrated_to_v2'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(0) > 0;

        let sql = if has_migrated_column {
            "SELECT id, mistake_id, role, content, timestamp, thinking_content,
                    rag_sources, memory_sources, graph_sources, web_search_sources,
                    image_paths, image_base64, doc_attachments, tool_call, tool_result,
                    stable_id, metadata
             FROM chat_messages
             WHERE migrated_to_v2 = 0 OR migrated_to_v2 IS NULL
             ORDER BY mistake_id, timestamp"
        } else {
            "SELECT id, mistake_id, role, content, timestamp, thinking_content,
                    rag_sources, memory_sources, graph_sources, web_search_sources,
                    image_paths, image_base64, doc_attachments, tool_call, tool_result,
                    stable_id, metadata
             FROM chat_messages
             ORDER BY mistake_id, timestamp"
        };

        let mut stmt = conn
            .prepare(sql)
            .map_err(|e| ChatV2Error::Database(format!("准备查询失败: {}", e)))?;

        let messages = stmt
            .query_map([], |row| {
                Ok(LegacyMessage {
                    id: row.get(0)?,
                    mistake_id: row.get(1)?,
                    role: row.get(2)?,
                    content: row.get(3)?,
                    timestamp: row.get(4)?,
                    thinking_content: row.get(5)?,
                    rag_sources: row.get(6)?,
                    memory_sources: row.get(7)?,
                    graph_sources: row.get(8)?,
                    web_search_sources: row.get(9)?,
                    image_paths: row.get(10)?,
                    image_base64: row.get(11)?,
                    doc_attachments: row.get(12)?,
                    tool_call: row.get(13)?,
                    tool_result: row.get(14)?,
                    stable_id: row.get(15)?,
                    metadata: row.get(16)?,
                })
            })
            .map_err(|e| ChatV2Error::Database(format!("查询消息失败: {}", e)))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| ChatV2Error::Database(format!("收集消息失败: {}", e)))?;

        Ok(messages)
    }

    /// 按 mistake_id 分组
    fn group_by_mistake_id(
        &self,
        messages: &[LegacyMessage],
    ) -> HashMap<String, Vec<LegacyMessage>> {
        let mut groups: HashMap<String, Vec<LegacyMessage>> = HashMap::new();
        for msg in messages {
            groups
                .entry(msg.mistake_id.clone())
                .or_default()
                .push(msg.clone());
        }
        groups
    }

    /// 获取会话标题
    /// 优先级：1. chat_metadata.title  2. ocr_text 前50字  3. user_question 前50字  4. 默认标题
    fn get_session_title(
        &self,
        data_conn: &Connection,
        mistake_id: &str,
        messages: &[LegacyMessage],
    ) -> String {
        // 1. 尝试从 mistakes 表获取标题信息
        let mistake_info: Option<(Option<String>, Option<String>, Option<String>)> = data_conn
            .query_row(
                "SELECT ocr_text, user_question, chat_metadata FROM mistakes WHERE id = ?1",
                [mistake_id],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0).ok().flatten(),
                        row.get::<_, Option<String>>(1).ok().flatten(),
                        row.get::<_, Option<String>>(2).ok().flatten(),
                    ))
                },
            )
            .ok();

        if let Some((ocr_text, user_question, chat_metadata_json)) = mistake_info {
            // 1.1 尝试从 chat_metadata.title 获取（普通聊天）
            if let Some(ref json_str) = chat_metadata_json {
                if let Ok(meta) = serde_json::from_str::<Value>(json_str) {
                    if let Some(title) = meta.get("title").and_then(|t| t.as_str()) {
                        if !title.is_empty() && title != "新对话" {
                            return self.truncate_title(title);
                        }
                    }
                }
            }

            // 1.2 优先使用 ocr_text（错题OCR内容）
            if let Some(ref text) = ocr_text {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    return self.truncate_title(trimmed);
                }
            }

            // 1.3 其次使用 user_question（用户问题）
            if let Some(ref question) = user_question {
                let trimmed = question.trim();
                if !trimmed.is_empty() {
                    return self.truncate_title(trimmed);
                }
            }
        }

        // 2. 尝试从第一条用户消息获取标题
        if let Some(first_user_msg) = messages.iter().find(|m| m.role == "user") {
            let content = first_user_msg.content.trim();
            if !content.is_empty() {
                return self.truncate_title(content);
            }
        }

        // 3. 默认标题
        "对话（迁移）".to_string()
    }

    /// 截断标题到指定长度
    fn truncate_title(&self, text: &str) -> String {
        // 移除换行符，只取第一行
        let first_line = text.lines().next().unwrap_or(text).trim();

        // 按字符截断（考虑中文）
        let chars: Vec<char> = first_line.chars().collect();
        if chars.len() <= TITLE_MAX_LENGTH {
            first_line.to_string()
        } else {
            let truncated: String = chars[..TITLE_MAX_LENGTH].iter().collect();
            format!("{}...", truncated)
        }
    }

    /// 创建 Chat V2 会话
    fn create_session(
        &self,
        conn: &Connection,
        mistake_id: &str,
        title: &str,
    ) -> Result<String, ChatV2Error> {
        let session_id = format!("sess_{}", uuid::Uuid::new_v4());
        let now = Utc::now();
        let created_at = now.to_rfc3339();
        let updated_at = now.to_rfc3339();

        // 元数据包含迁移信息
        let metadata = serde_json::json!({
            "mistakeId": mistake_id,
            "migratedFrom": "chat_messages",
            "migratedAt": now.timestamp_millis()
        });

        conn.execute(
            "INSERT INTO chat_v2_sessions (id, mode, title, persist_status, created_at, updated_at, metadata_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                session_id,
                "analysis",  // mode
                title,       // ★ 使用动态标题
                "active",    // persist_status
                created_at,
                updated_at,
                metadata.to_string(),
            ],
        )
        .map_err(|e| ChatV2Error::Database(format!("创建会话失败: {}", e)))?;

        Ok(session_id)
    }

    /// 迁移单条消息，返回创建的块数
    fn migrate_message(
        &mut self,
        conn: &Connection,
        session_id: &str,
        msg: &LegacyMessage,
    ) -> Result<usize, ChatV2Error> {
        let message_id = format!("msg_{}", uuid::Uuid::new_v4());
        let timestamp = self.parse_timestamp(&msg.timestamp);
        let role = if msg.role == "user" {
            "user"
        } else {
            "assistant"
        };

        // 构建消息元数据
        let meta = self.build_message_meta(msg);

        // 构建附件 JSON
        let attachments_json = self.build_attachments_json(msg)?;

        // ★ 先插入消息（空的 block_ids_json），避免外键约束失败
        conn.execute(
            "INSERT INTO chat_v2_messages (id, session_id, role, block_ids_json, timestamp, persistent_stable_id, meta_json, attachments_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                message_id,
                session_id,
                role,
                "[]",  // 先用空数组，后面更新
                timestamp,
                msg.stable_id,
                meta.map(|m| m.to_string()),
                attachments_json,
            ],
        )
        .map_err(|e| ChatV2Error::Database(format!("插入消息失败: {}", e)))?;

        // ★ 然后创建块（此时 message 已存在，外键约束不会失败）
        let mut block_ids = Vec::new();
        let mut block_index = 0;

        // 1. thinking 块
        if let Some(ref thinking) = msg.thinking_content {
            if !thinking.is_empty() {
                let block_id = self.create_block(
                    conn,
                    &message_id,
                    block_types::THINKING,
                    block_index,
                    Some(thinking),
                    None,
                )?;
                block_ids.push(block_id);
                block_index += 1;
            }
        }

        // 2. content 块
        if !msg.content.is_empty() {
            let block_id = self.create_block(
                conn,
                &message_id,
                block_types::CONTENT,
                block_index,
                Some(&msg.content),
                None,
            )?;
            block_ids.push(block_id);
            block_index += 1;
        }

        // 3. rag 块
        if let Some(ref sources) = msg.rag_sources {
            if sources != "[]" && !sources.is_empty() {
                let block_id = self.create_block(
                    conn,
                    &message_id,
                    block_types::RAG,
                    block_index,
                    None,
                    Some(sources),
                )?;
                block_ids.push(block_id);
                block_index += 1;
            }
        }

        // 4. memory 块
        if let Some(ref sources) = msg.memory_sources {
            if sources != "[]" && !sources.is_empty() {
                let block_id = self.create_block(
                    conn,
                    &message_id,
                    block_types::MEMORY,
                    block_index,
                    None,
                    Some(sources),
                )?;
                block_ids.push(block_id);
                block_index += 1;
            }
        }

        // 5. web_search 块
        if let Some(ref sources) = msg.web_search_sources {
            if sources != "[]" && !sources.is_empty() {
                let block_id = self.create_block(
                    conn,
                    &message_id,
                    block_types::WEB_SEARCH,
                    block_index,
                    None,
                    Some(sources),
                )?;
                block_ids.push(block_id);
                block_index += 1;
            }
        }

        // 6. graph 块
        if let Some(ref sources) = msg.graph_sources {
            if sources != "[]" && !sources.is_empty() {
                let block_id = self.create_block(
                    conn,
                    &message_id,
                    block_types::GRAPH,
                    block_index,
                    None,
                    Some(sources),
                )?;
                block_ids.push(block_id);
                block_index += 1;
            }
        }

        // 7. tool 块
        if let Some(ref tool_call) = msg.tool_call {
            if !tool_call.is_empty() && tool_call != "null" {
                let tool_output = msg.tool_result.as_deref();
                let block_id =
                    self.create_tool_block(conn, &message_id, block_index, tool_call, tool_output)?;
                block_ids.push(block_id);
                let _ = block_index; // last block, no further use
            }
        }

        let blocks_count = block_ids.len();

        // ★ 更新消息的 block_ids_json
        if !block_ids.is_empty() {
            conn.execute(
                "UPDATE chat_v2_messages SET block_ids_json = ?1 WHERE id = ?2",
                rusqlite::params![
                    serde_json::to_string(&block_ids).unwrap_or_else(|_| "[]".to_string()),
                    message_id,
                ],
            )
            .map_err(|e| ChatV2Error::Database(format!("更新消息块ID失败: {}", e)))?;
        }

        Ok(blocks_count)
    }

    /// 创建块
    fn create_block(
        &self,
        conn: &Connection,
        message_id: &str,
        block_type: &str,
        block_index: u32,
        content: Option<&str>,
        citations_json: Option<&str>,
    ) -> Result<String, ChatV2Error> {
        let block_id = format!("blk_{}", uuid::Uuid::new_v4());
        let now = Utc::now().timestamp_millis();

        conn.execute(
            "INSERT INTO chat_v2_blocks (id, message_id, block_type, status, block_index, content, citations_json, started_at, ended_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            rusqlite::params![
                block_id,
                message_id,
                block_type,
                block_status::SUCCESS,
                block_index,
                content,
                citations_json,
                now,
                now,
            ],
        )
        .map_err(|e| ChatV2Error::Database(format!("创建块失败: {}", e)))?;

        Ok(block_id)
    }

    /// 创建工具块
    fn create_tool_block(
        &self,
        conn: &Connection,
        message_id: &str,
        block_index: u32,
        tool_call_json: &str,
        tool_output_json: Option<&str>,
    ) -> Result<String, ChatV2Error> {
        let block_id = format!("blk_{}", uuid::Uuid::new_v4());
        let now = Utc::now().timestamp_millis();

        // 解析 tool_call 获取工具名
        let tool_name: Option<String> = serde_json::from_str::<Value>(tool_call_json)
            .ok()
            .and_then(|v| {
                v.get("name")
                    .and_then(|n| n.as_str())
                    .map(|s| s.to_string())
            });

        conn.execute(
            "INSERT INTO chat_v2_blocks (id, message_id, block_type, status, block_index, tool_name, tool_input_json, tool_output_json, started_at, ended_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            rusqlite::params![
                block_id,
                message_id,
                block_types::MCP_TOOL,
                block_status::SUCCESS,
                block_index,
                tool_name,
                tool_call_json,
                tool_output_json,
                now,
                now,
            ],
        )
        .map_err(|e| ChatV2Error::Database(format!("创建工具块失败: {}", e)))?;

        Ok(block_id)
    }

    /// 构建消息元数据
    fn build_message_meta(&self, msg: &LegacyMessage) -> Option<Value> {
        let mut meta = serde_json::Map::new();

        // 迁移来源标记
        meta.insert(
            "migratedFrom".to_string(),
            serde_json::json!("chat_messages"),
        );
        meta.insert("legacyId".to_string(), serde_json::json!(msg.id));

        // 原始 metadata
        if let Some(ref m) = msg.metadata {
            if let Ok(v) = serde_json::from_str::<Value>(m) {
                meta.insert("legacyMetadata".to_string(), v);
            }
        }

        if meta.is_empty() {
            None
        } else {
            Some(Value::Object(meta))
        }
    }

    /// 构建附件 JSON
    fn build_attachments_json(&self, msg: &LegacyMessage) -> Result<Option<String>, ChatV2Error> {
        let mut attachments = Vec::new();

        // 图片附件
        if let Some(ref paths) = msg.image_paths {
            if let Ok(paths_vec) = serde_json::from_str::<Vec<String>>(paths) {
                for (i, path) in paths_vec.iter().enumerate() {
                    attachments.push(serde_json::json!({
                        "id": format!("att_{}", uuid::Uuid::new_v4()),
                        "name": format!("image_{}.jpg", i + 1),
                        "type": "image",
                        "mimeType": "image/jpeg",
                        "size": 0,
                        "status": "ready",
                        "previewUrl": path,
                    }));
                }
            }
        }

        // base64 图片
        if let Some(ref base64s) = msg.image_base64 {
            if let Ok(base64_vec) = serde_json::from_str::<Vec<String>>(base64s) {
                for (i, b64) in base64_vec.iter().enumerate() {
                    attachments.push(serde_json::json!({
                        "id": format!("att_{}", uuid::Uuid::new_v4()),
                        "name": format!("image_{}.jpg", i + 1),
                        "type": "image",
                        "mimeType": "image/jpeg",
                        "size": b64.len(),
                        "status": "ready",
                        "previewUrl": format!("data:image/jpeg;base64,{}", b64),
                    }));
                }
            }
        }

        // 文档附件
        if let Some(ref docs) = msg.doc_attachments {
            if let Ok(docs_vec) = serde_json::from_str::<Vec<Value>>(docs) {
                for doc in docs_vec {
                    attachments.push(serde_json::json!({
                        "id": format!("att_{}", uuid::Uuid::new_v4()),
                        "name": doc.get("name").and_then(|v| v.as_str()).unwrap_or("document"),
                        "type": "document",
                        "mimeType": doc.get("mimeType").and_then(|v| v.as_str()).unwrap_or("application/octet-stream"),
                        "size": doc.get("size").and_then(|v| v.as_u64()).unwrap_or(0),
                        "status": "ready",
                    }));
                }
            }
        }

        if attachments.is_empty() {
            Ok(None)
        } else {
            Ok(Some(
                serde_json::to_string(&attachments).unwrap_or_else(|_| "[]".to_string()),
            ))
        }
    }

    /// 解析时间戳
    fn parse_timestamp(&self, ts: &str) -> i64 {
        DateTime::parse_from_rfc3339(ts)
            .map(|dt| dt.timestamp_millis())
            .unwrap_or_else(|e| {
                log::warn!(
                    "[LegacyMigration] Failed to parse timestamp '{}': {}, using epoch fallback",
                    ts,
                    e
                );
                0 // UNIX_EPOCH in millis — 避免旧数据"变成最新"
            })
    }

    /// 标记消息已迁移
    fn mark_message_migrated(
        &self,
        conn: &Connection,
        legacy_id: i64,
        session_id: &str,
    ) -> Result<(), ChatV2Error> {
        // 先检查列是否存在
        let has_column = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('chat_messages') WHERE name = 'migrated_to_v2'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(0) > 0;

        if !has_column {
            // 添加迁移标记列
            conn.execute(
                "ALTER TABLE chat_messages ADD COLUMN migrated_to_v2 INTEGER DEFAULT 0",
                [],
            )
            .ok(); // 忽略错误（列可能已存在）

            conn.execute(
                "ALTER TABLE chat_messages ADD COLUMN migrated_session_id TEXT",
                [],
            )
            .ok();
        }

        conn.execute(
            "UPDATE chat_messages SET migrated_to_v2 = 1, migrated_session_id = ?1 WHERE id = ?2",
            rusqlite::params![session_id, legacy_id],
        )
        .map_err(|e| ChatV2Error::Database(format!("标记迁移失败: {}", e)))?;

        Ok(())
    }
}

// ============================================================================
// 公开函数
// ============================================================================

/// 检查迁移状态
pub fn check_migration_status(
    data_conn: &Connection,
    chat_v2_conn: &Connection,
) -> Result<MigrationCheckResult, ChatV2Error> {
    let mut result = MigrationCheckResult::default();

    // 检查 chat_messages 表是否存在
    let table_exists: bool = data_conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='chat_messages'",
            [],
            |row| Ok(row.get::<_, i64>(0)? > 0),
        )
        .unwrap_or(false);

    if !table_exists {
        return Ok(result);
    }

    // 检查是否有 migrated_to_v2 列
    let has_migrated_column = data_conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('chat_messages') WHERE name = 'migrated_to_v2'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0)
        > 0;

    if has_migrated_column {
        // 统计未迁移消息
        result.pending_messages = data_conn
            .query_row(
                "SELECT COUNT(*) FROM chat_messages WHERE migrated_to_v2 = 0 OR migrated_to_v2 IS NULL",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        // 统计已迁移消息
        result.migrated_messages = data_conn
            .query_row(
                "SELECT COUNT(*) FROM chat_messages WHERE migrated_to_v2 = 1",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        // 统计未迁移会话数
        result.pending_sessions = data_conn
            .query_row(
                "SELECT COUNT(DISTINCT mistake_id) FROM chat_messages WHERE migrated_to_v2 = 0 OR migrated_to_v2 IS NULL",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);
    } else {
        // 所有消息都未迁移
        result.pending_messages = data_conn
            .query_row("SELECT COUNT(*) FROM chat_messages", [], |row| row.get(0))
            .unwrap_or(0);

        result.pending_sessions = data_conn
            .query_row(
                "SELECT COUNT(DISTINCT mistake_id) FROM chat_messages",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);
    }

    result.needs_migration = result.pending_messages > 0;

    // 判断是否可回滚：需要同时满足两个条件
    // 1. 旧表有标记为已迁移的消息
    // 2. Chat V2 中确实存在迁移的会话
    let migrated_sessions_in_v2: usize = chat_v2_conn
        .query_row(
            "SELECT COUNT(*) FROM chat_v2_sessions WHERE json_extract(metadata_json, '$.migratedFrom') = 'chat_messages'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    result.can_rollback = result.migrated_messages > 0 && migrated_sessions_in_v2 > 0;

    // 获取上次迁移时间（从 chat_v2_sessions 元数据中查询）
    let last_migration: Option<i64> = chat_v2_conn
        .query_row(
            "SELECT json_extract(metadata_json, '$.migratedAt') FROM chat_v2_sessions
             WHERE json_extract(metadata_json, '$.migratedFrom') = 'chat_messages'
             ORDER BY created_at DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .ok();
    result.last_migration_at = last_migration;

    Ok(result)
}

/// 执行迁移
pub fn migrate_legacy_chat(
    data_conn: &Connection,
    chat_v2_conn: &Connection,
    window: Option<Window>,
) -> Result<MigrationReport, ChatV2Error> {
    let mut executor = MigrationExecutor::new(window);
    executor.execute(data_conn, chat_v2_conn)
}

/// 回滚迁移
///
/// 为确保数据安全，回滚采用"先重置旧表标记，再删除新表数据"的顺序：
/// - 如果重置标记失败，不会删除新数据，用户可重试
/// - 如果删除新数据失败，旧表标记已重置，用户可重新迁移
pub fn rollback_migration(
    data_conn: &Connection,
    chat_v2_conn: &Connection,
    window: Option<Window>,
) -> Result<MigrationReport, ChatV2Error> {
    let mut report = MigrationReport::default();
    report.started_at = Utc::now().timestamp_millis();

    // 发送回滚开始事件
    if let Some(ref w) = window {
        let event = MigrationEvent {
            event_type: MigrationEventType::RollbackStarted,
            progress: MigrationProgress::default(),
            message: "开始回滚迁移".to_string(),
        };
        let _ = w.emit(MIGRATION_EVENT_CHANNEL, &event);
    }

    // 1. 查找所有迁移的会话 ID（先查询，用于后续删除）
    let migrated_sessions: Vec<String> = chat_v2_conn
        .prepare(
            "SELECT id FROM chat_v2_sessions WHERE json_extract(metadata_json, '$.migratedFrom') = 'chat_messages'",
        )
        .and_then(|mut stmt| {
            stmt.query_map([], |row| row.get(0))
                .map(|rows| rows.filter_map(log_and_skip_err).collect())
        })
        .unwrap_or_default();

    // 2. 先重置旧表的迁移标记（优先保证旧数据可恢复性）
    // 注意：此操作失败时会提前返回错误，不会删除新表数据
    let reset_count = data_conn
        .execute(
            "UPDATE chat_messages SET migrated_to_v2 = 0, migrated_session_id = NULL WHERE migrated_to_v2 = 1",
            [],
        )
        .map_err(|e| ChatV2Error::Database(format!("重置迁移标记失败: {}", e)))?;
    report.messages_migrated = reset_count;
    tracing::info!(
        "[Migration::Rollback] 已重置 {} 条消息的迁移标记",
        reset_count
    );

    // 3. 删除迁移的会话（级联删除消息和块）
    // 即使此步骤部分失败，旧表标记已重置，用户可重新迁移
    let mut delete_errors = Vec::new();
    for session_id in &migrated_sessions {
        if let Err(e) =
            chat_v2_conn.execute("DELETE FROM chat_v2_sessions WHERE id = ?", [session_id])
        {
            delete_errors.push(format!("删除会话 {} 失败: {}", session_id, e));
        } else {
            report.sessions_created += 1; // 复用字段表示删除数
        }
    }

    if !delete_errors.is_empty() {
        tracing::warn!(
            "[Migration::Rollback] 部分会话删除失败: {:?}",
            delete_errors
        );
        report.errors.extend(delete_errors);
    }

    report.ended_at = Utc::now().timestamp_millis();
    report.duration_ms = report.ended_at - report.started_at;
    report.status = MigrationStatus::RolledBack;

    // 发送回滚完成事件
    if let Some(ref w) = window {
        let event = MigrationEvent {
            event_type: MigrationEventType::RollbackCompleted,
            progress: MigrationProgress {
                status: MigrationStatus::RolledBack,
                ..Default::default()
            },
            message: format!(
                "回滚完成，删除 {} 个会话，重置 {} 条消息",
                migrated_sessions.len(),
                reset_count
            ),
        };
        let _ = w.emit(MIGRATION_EVENT_CHANNEL, &event);
    }

    Ok(report)
}
