-- ============================================================================
-- V20260528: 重建 resources 表，移除 type 列的 CHECK 约束
-- ============================================================================
-- 背景（审计报告 06 P1-2）：
--   V20260130 初始建表时 CHECK(type IN ('image','file','note','card','retrieval'))
--   只允许 5 种类型，而 Rust 侧 ResourceType 枚举已扩展到 10 种
--   （另含 exam / textbook / essay / translation / folder），写入新类型必然触发
--   "CHECK constraint failed"。SQLite 无法直接 ALTER CHECK，需整表重建。
--   类型合法性由 Rust 侧 ResourceType 枚举统一约束，DB 层不再重复维护
--   （避免枚举再次扩展时重蹈覆辙）。
--
-- 幂等性：所有语句均可安全重放；重建路径（建新表 → 拷贝 → 删旧表 → 改名）
--   在第二次执行时等价于一次无损自拷贝，数据不丢失。
-- ============================================================================

-- 1. 建新表（列定义/顺序与 V20260130 + V20260523 累积结果完全一致，仅去掉 CHECK）
CREATE TABLE IF NOT EXISTS resources_rebuild_v20260528 (
    id TEXT PRIMARY KEY,                               -- 资源 ID（格式：res_{nanoid(10)}）
    hash TEXT NOT NULL UNIQUE,                         -- 内容哈希（SHA-256，用于去重）
    type TEXT NOT NULL,                                -- 资源类型（合法值由 Rust ResourceType 枚举约束）
    source_id TEXT,                                    -- 原始数据 ID（noteId, cardId 等，用于跳转定位）
    data TEXT,                                         -- 实际内容（文本或 Base64 编码的二进制）
    metadata_json TEXT,                                -- 元数据（JSON 格式）
    ref_count INTEGER NOT NULL DEFAULT 0,              -- 引用计数（消息保存时 +1，删除时 -1）
    created_at INTEGER NOT NULL,                       -- 创建时间戳（毫秒）
    device_id TEXT,                                    -- V20260523: 同步设备 ID
    local_version INTEGER DEFAULT 0,                   -- V20260523: 本地版本号
    updated_at TEXT,                                   -- V20260523: 更新时间
    deleted_at TEXT                                    -- V20260523: 软删除时间
);

-- 2. 全量拷贝旧数据（OR IGNORE 保证重放安全）
INSERT OR IGNORE INTO resources_rebuild_v20260528
    (id, hash, type, source_id, data, metadata_json, ref_count, created_at,
     device_id, local_version, updated_at, deleted_at)
SELECT id, hash, type, source_id, data, metadata_json, ref_count, created_at,
       device_id, local_version, updated_at, deleted_at
FROM resources;

-- 3. 删除旧表（其索引与触发器随表一并删除）并改名
DROP TABLE resources;
ALTER TABLE resources_rebuild_v20260528 RENAME TO resources;

-- 4. 重建索引（与 V20260130 / V20260523 同名同定义）
CREATE INDEX IF NOT EXISTS idx_resources_hash ON resources(hash);
CREATE INDEX IF NOT EXISTS idx_resources_source_id ON resources(source_id);
CREATE INDEX IF NOT EXISTS idx_resources_type ON resources(type);
CREATE INDEX IF NOT EXISTS idx_resources_ref_count ON resources(ref_count);
CREATE INDEX IF NOT EXISTS idx_resources_created_at ON resources(created_at);
CREATE INDEX IF NOT EXISTS idx_resources_local_version ON resources(local_version);
CREATE INDEX IF NOT EXISTS idx_resources_deleted_at ON resources(deleted_at);
CREATE INDEX IF NOT EXISTS idx_resources_device_id ON resources(device_id);
CREATE INDEX IF NOT EXISTS idx_resources_sync_updated_at ON resources(updated_at);
CREATE INDEX IF NOT EXISTS idx_resources_device_version ON resources(device_id, local_version);
CREATE INDEX IF NOT EXISTS idx_resources_updated_not_deleted ON resources(updated_at) WHERE deleted_at IS NULL;

-- 5. 重建 __change_log 同步触发器（与 V20260523 同名同定义）
CREATE TRIGGER IF NOT EXISTS trg__change_log_resources_insert
AFTER INSERT ON resources
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('resources', NEW.id, 'INSERT');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_resources_update
AFTER UPDATE ON resources
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('resources', NEW.id, 'UPDATE');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_resources_delete
AFTER DELETE ON resources
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('resources', OLD.id, 'DELETE');
END;
