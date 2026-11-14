-- ============================================================================
-- V20260710: Anki 同步 Receipt 回写字段
-- ============================================================================
--
-- Sync 成功后把 Anki note id / 导出状态写回本地 anki_cards，
-- 消灭 syncStatus 空转（前端块状态与 DB 无 receipt）。
--
-- 与同日 FSRS 迁移 V20260709__flashcard_fsrs.sql 错开版本号
-- （Refinery 要求 V{integer}__{name}.sql，不能用 V20260709_1）。
--
-- 旧库已存在列时，coordinator 的 make_alter_columns_safe 会幂等跳过。
--
-- TODO(sync classification): anki_cards 新增列尚未登记到
-- data_governance/sync/classification.rs 的字段级 merge 策略；
-- 当前仅加列，云同步 FieldMerge 行为后续补齐。

ALTER TABLE anki_cards ADD COLUMN anki_note_id INTEGER;
ALTER TABLE anki_cards ADD COLUMN export_status TEXT;
ALTER TABLE anki_cards ADD COLUMN last_exported_at TEXT;
ALTER TABLE anki_cards ADD COLUMN content_hash TEXT;
