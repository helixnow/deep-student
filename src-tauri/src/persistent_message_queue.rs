#![allow(unused_variables)]
#![allow(dead_code)]

use chrono::{DateTime, Utc};
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use tauri::AppHandle;
use tokio::sync::{mpsc, Mutex};

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum MessageStatus {
    Pending = 0,
    Processing = 1,
    Completed = 2,
    Failed = 3,
    DeadLetter = 4,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum MessageType {
    Placeholder { data: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistentMessage {
    pub id: String,
    pub message_type: MessageType,
    pub status: i32,
    pub retry_count: u32,
    pub max_retries: u32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub next_retry_at: Option<DateTime<Utc>>,
    pub error_message: Option<String>,
}

pub struct PersistentMessageQueue {
    db_pool: Arc<Pool<SqliteConnectionManager>>,
    sender: mpsc::Sender<String>,
    handlers: Arc<Mutex<std::collections::HashMap<String, Arc<dyn MessageHandler + Send + Sync>>>>,
}

#[async_trait::async_trait]
pub trait MessageHandler: Send + Sync {
    async fn handle(&self, message: &PersistentMessage) -> Result<(), String>;
}

impl PersistentMessageQueue {
    pub fn new(db_path: PathBuf) -> Result<(Self, mpsc::Receiver<String>), String> {
        let manager = SqliteConnectionManager::file(db_path);
        let pool = Pool::new(manager).map_err(|e| format!("创建数据库连接池失败: {}", e))?;

        let conn = pool
            .get()
            .map_err(|e| format!("获取数据库连接失败: {}", e))?;
        Self::init_database(&conn)?;

        let (sender, receiver) = mpsc::channel(1000);

        Ok((
            Self {
                db_pool: Arc::new(pool),
                sender,
                handlers: Arc::new(Mutex::new(std::collections::HashMap::new())),
            },
            receiver,
        ))
    }

    pub fn export_prometheus_metrics(&self) -> String {
        let mut metrics = String::new();

        let conn = match self.db_pool.get() {
            Ok(conn) => conn,
            Err(e) => {
                metrics.push_str("# HELP message_queue_error Queue health error\n");
                metrics.push_str("# TYPE message_queue_error gauge\n");
                metrics.push_str(&format!("message_queue_error 1\n# error: {}\n", e));
                return metrics;
            }
        };

        let total: i64 = conn
            .query_row("SELECT COUNT(*) FROM message_queue", [], |row| row.get(0))
            .unwrap_or(0);
        let pending: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM message_queue WHERE status = ?1",
                params![MessageStatus::Pending as i32],
                |row| row.get(0),
            )
            .unwrap_or(0);

        metrics.push_str("# HELP message_queue_total Total messages in queue\n");
        metrics.push_str("# TYPE message_queue_total gauge\n");
        metrics.push_str(&format!("message_queue_total {}\n", total));
        metrics.push_str("# HELP message_queue_pending Pending messages\n");
        metrics.push_str("# TYPE message_queue_pending gauge\n");
        metrics.push_str(&format!("message_queue_pending {}\n", pending));

        metrics
    }

    fn init_database(conn: &Connection) -> Result<(), String> {
        conn.execute(
            "CREATE TABLE IF NOT EXISTS message_queue (
                id TEXT PRIMARY KEY,
                message_type TEXT NOT NULL,
                status INTEGER NOT NULL DEFAULT 0,
                retry_count INTEGER NOT NULL DEFAULT 0,
                max_retries INTEGER NOT NULL DEFAULT 3,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                next_retry_at TEXT,
                error_message TEXT
            )",
            [],
        )
        .map_err(|e| format!("创建消息队列表失败: {}", e))?;

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_message_queue_status ON message_queue(status)",
            [],
        )
        .map_err(|e| format!("创建索引失败: {}", e))?;

        Ok(())
    }

    pub async fn register_handler(
        &self,
        name: String,
        handler: Arc<dyn MessageHandler + Send + Sync>,
    ) {
        let mut handlers = self.handlers.lock().await;
        handlers.insert(name, handler);
    }
}

static PERSISTENT_MESSAGE_QUEUE: OnceLock<Arc<PersistentMessageQueue>> = OnceLock::new();
static RECEIVER: OnceLock<Mutex<Option<mpsc::Receiver<String>>>> = OnceLock::new();

pub fn init_persistent_message_queue(
    db_path: PathBuf,
) -> Result<Arc<PersistentMessageQueue>, String> {
    // 如果已经初始化，直接返回现有实例
    if let Some(queue) = PERSISTENT_MESSAGE_QUEUE.get() {
        return Ok(Arc::clone(queue));
    }

    // 首次初始化
    let (queue, receiver) = PersistentMessageQueue::new(db_path)?;
    let queue_arc = Arc::new(queue);

    // 尝试设置全局队列（处理并发初始化的情况）
    match PERSISTENT_MESSAGE_QUEUE.set(Arc::clone(&queue_arc)) {
        Ok(()) => {
            // 成功设置队列后，初始化 RECEIVER
            let _ = RECEIVER.set(Mutex::new(Some(receiver)));
            Ok(queue_arc)
        }
        Err(_) => {
            // 另一个线程先完成了初始化，返回那个实例
            // receiver 会被丢弃，但这是安全的
            Ok(PERSISTENT_MESSAGE_QUEUE
                .get()
                .expect("OnceLock should be initialized")
                .clone())
        }
    }
}

pub fn get_persistent_message_queue() -> Option<Arc<PersistentMessageQueue>> {
    PERSISTENT_MESSAGE_QUEUE.get().cloned()
}

pub async fn start_message_processor() -> Result<(), String> {
    println!("消息队列处理器已启动（简化模式）");
    Ok(())
}

pub async fn register_message_handlers(
    _database: Arc<crate::database::Database>,
    _llm_manager: Arc<crate::llm_manager::LLMManager>,
    _app_handle: Option<AppHandle>,
) -> Result<(), String> {
    println!("消息处理器注册完成（简化模式）");
    Ok(())
}

pub fn export_queue_metrics() -> Option<String> {
    get_persistent_message_queue().map(|q| q.export_prometheus_metrics())
}
