-- 创建模板表（如果不存在）
CREATE TABLE IF NOT EXISTS custom_anki_templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    author TEXT,
    version TEXT,
    preview_front TEXT,
    preview_back TEXT,
    note_type TEXT DEFAULT 'Basic',
    fields_json TEXT DEFAULT '[]',
    generation_prompt TEXT,
    front_template TEXT NOT NULL,
    back_template TEXT NOT NULL,
    css_style TEXT,
    field_extraction_rules_json TEXT DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT 1,
    is_built_in BOOLEAN DEFAULT 0
);

-- 创建版本控制表（如果不存在）
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 删除指定的内置卡片模板
DELETE FROM custom_anki_templates WHERE id IN (
    'concept-comparison-card',
    'math-formula-card',
    'historical-events-card',
    'medical-terms-card'
);