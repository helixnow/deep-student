-- V20260215: 题目集导入断点续导支持
--
-- 新增 import_state_json 列，持久化导入中间状态：
-- - text_content: OCR/提取后的文本（最昂贵的中间产物）
-- - chunks_total: 总 chunk 数
-- - chunks_completed: 已完成的 chunk 数
-- - model_config_id: 解析模型 ID
-- - source_image_hashes: 原始图片 blob 哈希列表
--
-- 正常完成后该列被清空（NULL），仅 status='importing' 时有值。

ALTER TABLE exam_sheets ADD COLUMN import_state_json TEXT;
