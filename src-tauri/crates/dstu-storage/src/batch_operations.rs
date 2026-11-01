use anyhow::Result;
use chrono::Utc;
use rusqlite::{params, Connection};

pub struct BatchOperations<'a> {
    conn: &'a mut Connection,
}

impl<'a> BatchOperations<'a> {
    pub fn new(conn: &'a mut Connection) -> Self {
        Self { conn }
    }

    /// Batch operation: Archive old mistakes (change status to "archived")
    pub fn batch_archive_old_mistakes(&mut self, days_old: i64) -> Result<usize> {
        let tx = self.conn.transaction()?;

        let cutoff_date = (Utc::now() - chrono::Duration::days(days_old)).to_rfc3339();

        let updated_count = tx.execute(
            "UPDATE mistakes SET status = 'archived', updated_at = ?1, last_accessed_at = ?1
             WHERE created_at < ?2 AND status != 'archived'",
            params![Utc::now().to_rfc3339(), cutoff_date],
        )?;

        tx.commit()?;
        Ok(updated_count)
    }

    /// Batch cleanup: Remove orphaned chat messages
    pub fn batch_cleanup_orphaned_messages(&mut self) -> Result<usize> {
        let tx = self.conn.transaction()?;

        let deleted_count = tx.execute(
            "DELETE FROM chat_messages
             WHERE mistake_id NOT IN (SELECT id FROM mistakes)",
            [],
        )?;

        tx.commit()?;
        Ok(deleted_count)
    }
}

/// Extension trait for Database to add batch operations
pub trait BatchOperationExt {
    fn with_batch_operations<F, R>(&self, f: F) -> Result<R>
    where
        F: FnOnce(&mut BatchOperations) -> Result<R>;
}

impl BatchOperationExt for crate::database::Database {
    fn with_batch_operations<F, R>(&self, f: F) -> Result<R>
    where
        F: FnOnce(&mut BatchOperations) -> Result<R>,
    {
        let mut conn = self
            .get_conn_safe()
            .map_err(|e| anyhow::anyhow!("获取数据库连接失败: {}", e))?;
        let mut batch_ops = BatchOperations::new(&mut conn);
        f(&mut batch_ops)
    }
}
