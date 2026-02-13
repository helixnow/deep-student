-- V20260205__add_compressed_blob_hash.sql
-- 为图片文件添加压缩版本的 blob 引用

-- 添加 compressed_blob_hash 字段
-- 用于存储图片压缩后的 blob hash，可选字段
-- 如果图片不需要压缩（小于阈值），则保持为 NULL
ALTER TABLE files ADD COLUMN compressed_blob_hash TEXT;

-- 添加索引以支持通过 compressed_blob_hash 查询
CREATE INDEX IF NOT EXISTS idx_files_compressed_blob_hash ON files(compressed_blob_hash);
