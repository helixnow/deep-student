use anyhow::Result;
use rusqlite::Connection;

pub struct DatabaseOptimizations;

impl DatabaseOptimizations {
    /// Create database indexes for better performance
    pub fn create_performance_indexes(conn: &Connection) -> Result<()> {
        let indexes = vec![
            // Index on chat_messages for faster joins
            "CREATE INDEX IF NOT EXISTS idx_chat_messages_mistake_id ON chat_messages(mistake_id)",
            "CREATE INDEX IF NOT EXISTS idx_chat_messages_timestamp ON chat_messages(timestamp)",
        ];

        for index_sql in indexes {
            conn.execute(index_sql, [])?;
            println!("Created index: {}", index_sql);
        }

        Ok(())
    }

    /// Analyze query performance and suggest optimizations
    pub fn analyze_query_performance(conn: &Connection, query: &str) -> Result<String> {
        let explain_query = format!("EXPLAIN QUERY PLAN {}", query);

        let mut stmt = conn.prepare(&explain_query)?;
        let rows = stmt.query_map([], |row| {
            Ok(format!(
                "Level {}: {} - {}",
                row.get::<_, i32>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?
            ))
        })?;

        let mut analysis = Vec::new();
        for row_result in rows {
            analysis.push(row_result?);
        }

        Ok(analysis.join("\n"))
    }
}

/// Extension trait to add optimized methods to Database
pub trait DatabaseOptimizationExt {
    fn create_performance_indexes(&self) -> Result<()>;
    fn analyze_query_performance(&self, query: &str) -> Result<String>;
}

impl DatabaseOptimizationExt for crate::database::Database {
    fn create_performance_indexes(&self) -> Result<()> {
        let conn = self
            .get_conn_safe()
            .map_err(|e| anyhow::anyhow!("获取数据库连接失败: {}", e))?;
        DatabaseOptimizations::create_performance_indexes(&conn)
    }

    fn analyze_query_performance(&self, query: &str) -> Result<String> {
        let conn = self
            .get_conn_safe()
            .map_err(|e| anyhow::anyhow!("获取数据库连接失败: {}", e))?;
        DatabaseOptimizations::analyze_query_performance(&conn, query)
    }
}
