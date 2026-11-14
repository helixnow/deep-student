-- ============================================================================
-- V20260202: 为 vfs_index_segments 添加 unit_id 外键约束
-- ============================================================================
-- 
-- 问题：vfs_index_segments.unit_id 列没有外键约束，删除 vfs_index_units 记录后，
--       segments 不会级联删除，导致孤立数据。
--
-- 由于 SQLite 不支持 ALTER TABLE ADD FOREIGN KEY，需要重建表。
--
-- ============================================================================
-- 
-- 🔧 健壮性设计原则：
-- 1. 幂等性：脚本可以安全重复执行
-- 2. 防御性：迁移前清理孤儿数据，确保外键约束满足
-- 3. 中间状态处理：清理可能存在的临时表（来自之前失败的迁移）
-- 4. 原子性：整个脚本在单个事务中执行（由 Refinery set_grouped(true) 保证）
--
-- ============================================================================

-- ============================================================================
-- STEP 0: 中间状态清理（处理之前失败的迁移遗留）
-- ============================================================================
-- 如果之前迁移失败，可能存在 vfs_index_segments_new 表
-- 需要先清理，否则后续 CREATE TABLE 可能冲突
DROP TABLE IF EXISTS vfs_index_segments_new;

-- ============================================================================
-- STEP 1: 数据完整性修复（防御性编程）
-- ============================================================================
-- 删除所有孤儿记录（unit_id 不存在于 vfs_index_units 表中的记录）
-- 这是导致外键约束失败的根本原因
-- 注意：这些数据本身就是无效的，删除它们是安全的
DELETE FROM vfs_index_segments 
WHERE unit_id NOT IN (SELECT id FROM vfs_index_units);

-- ============================================================================
-- STEP 2: 创建带外键约束的新表
-- ============================================================================
CREATE TABLE vfs_index_segments_new (
    id TEXT PRIMARY KEY,
    unit_id TEXT NOT NULL,
    segment_index INTEGER NOT NULL,
    modality TEXT NOT NULL,
    embedding_dim INTEGER NOT NULL,
    lance_row_id TEXT NOT NULL,
    content_text TEXT,
    content_hash TEXT,
    start_pos INTEGER,
    end_pos INTEGER,
    metadata_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (unit_id) REFERENCES vfs_index_units(id) ON DELETE CASCADE
);

-- ============================================================================
-- STEP 3: 复制数据（此时数据已经是干净的，外键约束一定满足）
-- ============================================================================
INSERT INTO vfs_index_segments_new 
SELECT * FROM vfs_index_segments;

-- ============================================================================
-- STEP 4: 删除旧表
-- ============================================================================
DROP TABLE vfs_index_segments;

-- ============================================================================
-- STEP 5: 重命名新表
-- ============================================================================
ALTER TABLE vfs_index_segments_new RENAME TO vfs_index_segments;

-- ============================================================================
-- STEP 6: 重建索引
-- ============================================================================
CREATE UNIQUE INDEX IF NOT EXISTS idx_vfs_index_segments_unique 
    ON vfs_index_segments(unit_id, segment_index, modality, embedding_dim);
CREATE INDEX IF NOT EXISTS idx_segments_unit_id 
    ON vfs_index_segments(unit_id);
CREATE INDEX IF NOT EXISTS idx_segments_modality 
    ON vfs_index_segments(modality);
CREATE INDEX IF NOT EXISTS idx_segments_lance_row_id 
    ON vfs_index_segments(lance_row_id);
