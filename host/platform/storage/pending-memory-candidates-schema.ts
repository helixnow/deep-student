/**
 * `mistakes.db` 的 `pending_memory_candidates` 表（记忆 `knowledge_extract` 写入、Anki 命令读取）。
 *
 * RUST-FIX(RF-W07-pending-memory-candidates-schema): Rust v0.9.2（`1813b3c9c`，`database/manager.rs:698-716`）
 * 以 `CREATE TABLE IF NOT EXISTS` 建表且没有 `subject` 列，`c006f457b` 删掉建表又没有迁移接手：新库没有这张表，
 * v0.9.2 升级上来的库有表但缺 `subject`，而 `knowledge_executor.rs:125` 的 INSERT 与 `enhanced_anki.rs:751`
 * 的 SELECT 都用 `subject`，两条路径永远失败。这里以幂等修复补齐（不写 `refinery_schema_history`：
 * 版本号高于旧版 Rust 已知最新版会让旧版拒绝恢复 B 的备份，见 `backup/mod.rs:4890`；表不在迁移管理范围内，
 * 也不进入 schema 指纹）。
 */

/** Rust 写入的固定科目（`knowledge_executor.rs:131`），也是旧行补列的默认值。 */
export const PENDING_MEMORY_DEFAULT_SUBJECT = '通用';

const SUBJECT_COLUMN = `subject TEXT NOT NULL DEFAULT '${PENDING_MEMORY_DEFAULT_SUBJECT}'`;

/** v0.9.2 的 DDL 原文，`subject` 追加在末尾，与旧表 `ADD COLUMN` 后的列顺序一致。 */
export const PENDING_MEMORY_CANDIDATES_TABLE_SQL = `CREATE TABLE IF NOT EXISTS pending_memory_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    content TEXT NOT NULL,
    category TEXT NOT NULL,
    origin TEXT DEFAULT 'auto_extract',
    user_edited INTEGER DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'saved', 'dismissed')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    expires_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+7 days')),
    subject TEXT NOT NULL DEFAULT '${PENDING_MEMORY_DEFAULT_SUBJECT}'
)`;

export const PENDING_MEMORY_CANDIDATES_INDEX_SQL: readonly string[] = [
  'CREATE INDEX IF NOT EXISTS idx_pending_mem_conversation ON pending_memory_candidates(conversation_id)',
  'CREATE INDEX IF NOT EXISTS idx_pending_mem_status ON pending_memory_candidates(status)',
  'CREATE INDEX IF NOT EXISTS idx_pending_mem_expires ON pending_memory_candidates(expires_at)',
];

export interface SchemaRepairConnection {
  exec(sql: string): void;
  all<R>(sql: string): R[];
}

export type PendingMemorySchemaRepair = 'none' | 'created' | 'added_subject';

/** 建表或给 v0.9.2 旧表补 `subject`，再补索引；已是目标形状时不写库。 */
export function ensurePendingMemoryCandidatesSchema(conn: SchemaRepairConnection): PendingMemorySchemaRepair {
  const columns = conn.all<{ name: string }>("SELECT name FROM pragma_table_info('pending_memory_candidates')");
  let repair: PendingMemorySchemaRepair = 'none';
  if (columns.length === 0) {
    conn.exec(PENDING_MEMORY_CANDIDATES_TABLE_SQL);
    repair = 'created';
  } else if (!columns.some((column) => column.name === 'subject')) {
    conn.exec(`ALTER TABLE pending_memory_candidates ADD COLUMN ${SUBJECT_COLUMN}`);
    repair = 'added_subject';
  }
  for (const sql of PENDING_MEMORY_CANDIDATES_INDEX_SQL) conn.exec(sql);
  return repair;
}
