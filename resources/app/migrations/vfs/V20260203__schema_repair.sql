-- ============================================================================
-- V20260203: Schema 修复迁移
-- ============================================================================
-- 
-- 目的：确保从旧版本升级的数据库具有与新数据库相同的 Schema
--
-- 背景：旧数据库可能缺少某些在 init 脚本中定义但后来添加的表/索引
--       此脚本使用 IF NOT EXISTS 确保幂等性
--
-- @skip-check: idempotent_create
-- @skip-check: idempotent_index
-- ============================================================================

-- 确保 files 表的 sha256 索引存在
CREATE INDEX IF NOT EXISTS idx_files_sha256 ON files(sha256);

-- 确保其他可能缺失的核心索引存在
CREATE INDEX IF NOT EXISTS idx_files_resource ON files(resource_id);
CREATE INDEX IF NOT EXISTS idx_files_blob ON files(blob_hash);
CREATE INDEX IF NOT EXISTS idx_files_deleted_at ON files(deleted_at);

-- 确保 notes 表的索引存在
CREATE INDEX IF NOT EXISTS idx_notes_resource ON notes(resource_id);
CREATE INDEX IF NOT EXISTS idx_notes_deleted ON notes(deleted_at);
