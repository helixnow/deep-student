//! 统一会话管理模块
//! 🎯 架构改进：提供统一的会话管理接口，减少代码重复

#![allow(async_fn_in_trait)] // trait 中使用 async fn 是设计选择

use crate::database::Database;
use crate::models::{AppError, StreamContext};
use std::collections::HashMap;
use tokio::sync::Mutex;
/// 通用结果类型
type Result<T> = std::result::Result<T, AppError>;

/// 统一会话管理trait
pub trait SessionManager<T: Clone> {
    /// 从内存获取会话
    async fn get_session_from_memory(&self, session_id: &str) -> Option<T>;

    /// 从数据库恢复会话
    async fn restore_session_from_database(&self, session_id: &str) -> Result<Option<T>>;

    /// 保存会话到内存
    async fn save_session_to_memory(&self, session_id: String, session: T);

    /// 保存会话到数据库（带重试机制）
    async fn save_session_to_database(&self, session: &T) -> Result<()>;

    /// 获取会话（优先内存，回退数据库）
    async fn get_session(&self, session_id: &str) -> Result<T> {
        // 首先尝试从内存获取
        if let Some(session) = self.get_session_from_memory(session_id).await {
            return Ok(session);
        }

        // 如果内存中没有，尝试从数据库恢复
        match self.restore_session_from_database(session_id).await? {
            Some(session) => {
                // 将恢复的会话存回内存缓存
                self.save_session_to_memory(session_id.to_string(), session.clone())
                    .await;
                Ok(session)
            }
            None => Err(AppError::not_found("会话不存在")),
        }
    }
}

/// 回顾分析功能已移除

/// 回顾分析会话管理器已移除

/// 流式上下文管理器（首轮分析的缓存管理）
pub struct StreamContextManager {
    sessions: Mutex<HashMap<String, StreamContext>>,
    database: Database,
}

impl StreamContextManager {
    pub fn new(database: Database) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            database,
        }
    }

    /// 创建新的流式上下文
    pub async fn create_session(&self, session: StreamContext) {
        let mut sessions = self.sessions.lock().await;
        sessions.insert(session.temp_id.clone(), session);
    }

    /// 获取流式上下文
    pub async fn get_temp_session(&self, temp_id: &str) -> Option<StreamContext> {
        let sessions = self.sessions.lock().await;
        sessions.get(temp_id).cloned()
    }

    /// 更新流式上下文
    pub async fn update_temp_session(&self, temp_id: &str, session: StreamContext) {
        let mut sessions = self.sessions.lock().await;
        sessions.insert(temp_id.to_string(), session);
    }
}

// ReviewSessionManager已移除
