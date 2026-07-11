pub mod audit_log;
pub mod auto_extractor;
pub mod category_manager;
pub mod compaction_flush;
pub mod compressor;
pub mod config;
pub mod daily_log;
pub mod evolution;
pub mod handlers;
pub mod learner_profile;
pub mod llm_decision;
pub mod query_rewriter;
pub mod reranker;
pub mod service;

use std::sync::{Mutex, MutexGuard};

use crate::vfs::error::VfsError;

/// Serializes creation of reserved memory folders/notes.
///
/// Updates remain optimistic and concurrent; only the rare "missing -> create"
/// transition is serialized so two writers cannot create duplicate system
/// notes before CAS tokens exist.
static MEMORY_STRUCTURE_LOCK: Mutex<()> = Mutex::new(());

pub(crate) fn lock_memory_structure() -> MutexGuard<'static, ()> {
    MEMORY_STRUCTURE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) fn is_retryable_sqlite_lock(error: &VfsError) -> bool {
    let VfsError::Database(message) = error else {
        return false;
    };
    let message = message.to_ascii_lowercase();
    message.contains("database is locked")
        || message.contains("database table is locked")
        || message.contains("database schema is locked")
        || message.contains("sqlite_busy")
        || message.contains("sqlite_locked")
}

pub(crate) fn backoff_memory_write(attempt: usize) {
    let delay_ms = 1_u64 << attempt.min(5);
    std::thread::sleep(std::time::Duration::from_millis(delay_ms));
}

pub use audit_log::{MemoryAuditLogItem, MemoryAuditLogger, MemoryOpSource, MemoryOpType, OpTimer};
pub use auto_extractor::MemoryAutoExtractor;
pub use category_manager::MemoryCategoryManager;
pub use compaction_flush::{CompactionMemoryFlush, FlushExtraction, FlushReport};
pub use compressor::MemoryCompressor;
pub use config::{AutoExtractFrequency, MemoryConfig};
pub use evolution::MemoryEvolution;
pub use handlers::*;
pub use learner_profile::{LearnerProfile, LearnerProfileUpdate};
pub use llm_decision::{
    MemoryDecisionResponse, MemoryEvent, MemoryLLMDecision, SimilarMemorySummary,
};
pub use query_rewriter::{MemoryQueryRewriter, QueryRewriteResult};
pub use reranker::MemoryReranker;
pub use service::{
    MemoryListItem, MemoryPurpose, MemorySearchResult, MemoryService, MemoryType, SmartWriteOutput,
    WriteMode,
};

#[cfg(test)]
pub(crate) mod test_support {
    use std::sync::Arc;

    use tempfile::TempDir;

    use crate::database::Database;
    use crate::file_manager::FileManager;
    use crate::llm_manager::LLMManager;
    use crate::vfs::database::{setup_migrated_test_db, VfsDatabase};
    use crate::vfs::lance_store::VfsLanceStore;

    use super::MemoryService;

    pub(crate) fn setup_memory_service() -> (TempDir, Arc<VfsDatabase>, MemoryService) {
        let (temp_dir, vfs_db) = setup_migrated_test_db();
        let vfs_db = Arc::new(vfs_db);

        let main_db_path = temp_dir.path().join("memory-test.db");
        let conn = rusqlite::Connection::open(&main_db_path).expect("open memory test db");
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );",
        )
        .expect("create settings table");
        drop(conn);

        let main_db = Arc::new(Database::new(&main_db_path).expect("create main test database"));
        let file_manager = Arc::new(
            FileManager::new(temp_dir.path().to_path_buf()).expect("create test file manager"),
        );
        let llm_manager =
            Arc::new(LLMManager::new(main_db, file_manager).expect("create test LLM manager"));
        let lance_store =
            Arc::new(VfsLanceStore::new(vfs_db.clone()).expect("create test VFS Lance store"));
        let service = MemoryService::new(vfs_db.clone(), lance_store, llm_manager);

        (temp_dir, vfs_db, service)
    }
}
