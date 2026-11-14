-- ============================================================================
-- V20260726: mindmaps.content_updated_at — OCC 内容锁与元数据时间戳解耦（B5）
-- ============================================================================
--
-- 背景：编辑器乐观锁（expected_updated_at）此前比较 mindmaps.updated_at，
-- 而收藏、重命名等纯元数据操作也会推进 updated_at，导致正在编辑的客户端
-- 出现无意义的 MINDMAP_UPDATE_CONFLICT 伪冲突。
--
-- 方案：新增 content_updated_at 列，仅在 MindMapDocument 内容实际变化
-- （含版本恢复）时推进；OCC 过渡策略为 expected 与 content_updated_at 或
-- updated_at 任一匹配即放行（存量前端仍携带 metadata.updatedAt）。
--
-- 幂等性说明：SQLite 不支持 ADD COLUMN IF NOT EXISTS；本迁移遵循仓库
-- 现有约定（V20260523/V20260719 同款）——迁移框架逐条执行并立即记录
-- refinery_schema_history，coordinator 对 duplicate column 有预修复兜底。
-- 回填 UPDATE 自身幂等（仅作用于 NULL 行）。
--
-- 同步说明：mindmaps 为 RowSync + FieldMerge（行级 LWW），新列随整行
-- 同步，无需新增触发器或分类登记。
-- ============================================================================
-- @danger-ack: add_column_backfill reason="新列可空且回填仅作用于 NULL 行；失败重跑时 ADD COLUMN 由 coordinator 的 duplicate column 预修复兜底，UPDATE 天然幂等，不会留下不可恢复的半迁移状态"

ALTER TABLE mindmaps ADD COLUMN content_updated_at TEXT;

-- 回填：历史行以最后一次 updated_at 作为内容基线
UPDATE mindmaps
SET content_updated_at = updated_at
WHERE content_updated_at IS NULL;
