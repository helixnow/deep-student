-- ============================================================================
-- V20260204: 添加 PDF 预处理流水线状态字段
-- ============================================================================
--
-- 目的：支持 PDF 上传后的自动预处理流水线，包括：
--   - Stage 1: 文本提取 (text_extraction)
--   - Stage 2: 页面渲染 (page_rendering)
--   - Stage 3: OCR 处理 (ocr_processing)
--   - Stage 4: 向量索引 (vector_indexing)
--
-- 参考设计文档：docs/design/pdf-preprocessing-pipeline.md
-- ============================================================================

-- 添加处理状态字段
-- 可选值: pending | text_extraction | page_rendering | ocr_processing | vector_indexing | completed | error
ALTER TABLE files ADD COLUMN processing_status TEXT DEFAULT 'pending';

-- 添加处理进度 JSON
-- 格式: {"stage":"page_rendering","current_page":10,"total_pages":50,"percent":20.0,"ready_modes":["text"]}
ALTER TABLE files ADD COLUMN processing_progress TEXT;

-- 添加处理错误信息（error 状态时填充）
ALTER TABLE files ADD COLUMN processing_error TEXT;

-- 添加处理开始时间戳（毫秒）
ALTER TABLE files ADD COLUMN processing_started_at INTEGER;

-- 添加处理完成时间戳（毫秒）
ALTER TABLE files ADD COLUMN processing_completed_at INTEGER;

-- ============================================================================
-- 向后兼容：为已有 PDF 文件设置 completed 状态
-- ============================================================================
-- 规则：
--   1. 已有 preview_json 或 extracted_text 的 PDF 视为 completed
--   2. 其他 PDF 设为 pending（等待后台处理）
--   3. 非 PDF 文件保持 NULL（不参与流水线）

-- 已有预渲染或文本的 PDF 设为 completed
UPDATE files 
SET processing_status = 'completed',
    processing_progress = '{"stage":"completed","percent":100,"ready_modes":["text","image"]}',
    processing_completed_at = (strftime('%s', 'now') * 1000)
WHERE mime_type = 'application/pdf' 
  AND processing_status = 'pending'
  AND (preview_json IS NOT NULL OR extracted_text IS NOT NULL);

-- 已有 OCR 的 PDF 更新 ready_modes
UPDATE files 
SET processing_progress = '{"stage":"completed","percent":100,"ready_modes":["text","image","ocr"]}'
WHERE mime_type = 'application/pdf' 
  AND processing_status = 'completed'
  AND ocr_pages_json IS NOT NULL;

-- ============================================================================
-- 索引：优化状态查询性能
-- ============================================================================

-- 按处理状态查询（用于查找待处理/失败的文件）
CREATE INDEX IF NOT EXISTS idx_files_processing_status ON files(processing_status);

-- 复合索引：PDF 文件 + 处理状态（用于流水线任务查询）
CREATE INDEX IF NOT EXISTS idx_files_pdf_processing 
ON files(mime_type, processing_status) 
WHERE mime_type = 'application/pdf';

-- 处理中文件查询（用于恢复中断的任务）
CREATE INDEX IF NOT EXISTS idx_files_processing_started 
ON files(processing_started_at) 
WHERE processing_status IN ('text_extraction', 'page_rendering', 'ocr_processing', 'vector_indexing');
