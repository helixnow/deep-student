-- V20260209: 为 questions 表添加图片支持
--
-- images_json 存储 JSON 数组，每个元素是一个 VFS 附件引用：
-- [{"id":"att_xxx","name":"图片.png","mime":"image/png","hash":"sha256..."}]
--
-- 默认值 '[]' 表示无图片。

ALTER TABLE questions ADD COLUMN images_json TEXT DEFAULT '[]';
