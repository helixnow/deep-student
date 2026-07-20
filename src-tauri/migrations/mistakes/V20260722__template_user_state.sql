-- ============================================================================
-- Mistakes: custom_anki_templates 用户态标记
--
-- 背景（模板 CRUD 数据安全加固）：
-- 1. 内置模板版本升级导入（import_builtin_templates）此前会无条件覆盖，
--    用户对内置模板的修改 / 删除会被静默"复活"。
-- 2. 内置模板删除统一为"停用（打标记）而非物理删除"，保证模板 ID 稳定，
--    存量 anki_cards.template_id 绑定不断裂。
--
-- 新增列：
-- - user_modified: 用户修改过该内置模板（版本升级导入时跳过覆盖，保留用户版本）
-- - user_deleted:  用户删除（停用）过该内置模板的墓碑标记（版本升级导入时不复活）
--
-- 旧库已存在同名列时由治理层 make_alter_columns_safe 幂等跳过。
-- ============================================================================

ALTER TABLE custom_anki_templates ADD COLUMN user_modified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE custom_anki_templates ADD COLUMN user_deleted INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_custom_anki_templates_user_deleted
    ON custom_anki_templates(user_deleted);
