-- Study Space VFS profiles, zero-copy cross-space mounts, and semantic anchor backlink edges.
-- Canonical folder_items and idx_folder_items_item_active_unique are intentionally untouched.
-- Note: fld_inbox is provisioned idempotently on demand via vfs_ensure_inbox_folder.

-- 1. Study Space metadata profile (1:1 with chat_v2_session_groups.id)
CREATE TABLE IF NOT EXISTS vfs_study_space_profiles (
    space_id TEXT PRIMARY KEY,
    root_folder_id TEXT NOT NULL,
    exam_date TEXT,
    daily_budget_minutes INTEGER NOT NULL DEFAULT 45
        CHECK(daily_budget_minutes BETWEEN 5 AND 480),
    target_retention REAL NOT NULL DEFAULT 0.90
        CHECK(target_retention >= 0.70 AND target_retention <= 0.97),
    workbench_layout_preset TEXT NOT NULL DEFAULT 'split_reader_chat'
        CHECK(workbench_layout_preset IN (
            'chat_focus',
            'split_reader_chat',
            'split_notes_chat',
            'practice_review',
            'freeform_desktop'
        )),
    default_deck_id TEXT,
    memory_scope TEXT NOT NULL DEFAULT 'space_and_global'
        CHECK(memory_scope IN ('space_isolated', 'space_and_global', 'global_only')),
    device_id TEXT,
    local_version INTEGER NOT NULL DEFAULT 1,
    sync_version INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_vfs_study_space_profiles_root_folder
    ON vfs_study_space_profiles(root_folder_id)
    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_vfs_study_space_profiles_local_version
    ON vfs_study_space_profiles(local_version);
CREATE INDEX IF NOT EXISTS idx_vfs_study_space_profiles_deleted_at
    ON vfs_study_space_profiles(deleted_at);
CREATE INDEX IF NOT EXISTS idx_vfs_study_space_profiles_device_version
    ON vfs_study_space_profiles(device_id, local_version);
CREATE INDEX IF NOT EXISTS idx_vfs_study_space_profiles_updated_active
    ON vfs_study_space_profiles(updated_at)
    WHERE deleted_at IS NULL;

CREATE TRIGGER IF NOT EXISTS trg__change_log_vfs_study_space_profiles_insert
AFTER INSERT ON vfs_study_space_profiles
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('vfs_study_space_profiles', NEW.space_id, 'INSERT');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_vfs_study_space_profiles_update
AFTER UPDATE ON vfs_study_space_profiles
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('vfs_study_space_profiles', NEW.space_id, 'UPDATE');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_vfs_study_space_profiles_delete
AFTER DELETE ON vfs_study_space_profiles
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('vfs_study_space_profiles', OLD.space_id, 'DELETE');
END;

-- 2. Zero-copy cross-space resource/folder mounts
CREATE TABLE IF NOT EXISTS vfs_space_mounts (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL,
    target_folder_id TEXT NOT NULL,
    item_type TEXT NOT NULL
        CHECK(item_type IN ('note', 'exam', 'file', 'image', 'translation', 'essay', 'mindmap', 'folder')),
    item_id TEXT NOT NULL,
    device_id TEXT,
    local_version INTEGER NOT NULL DEFAULT 1,
    sync_version INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT
);

-- @danger-ack: unique_constraint reason="Active cross-space mount deduplicated by (target_folder_id, item_type, item_id); soft-deleted rows excluded via WHERE deleted_at IS NULL and registered in sync business_unique_keys"
CREATE UNIQUE INDEX IF NOT EXISTS idx_vfs_space_mounts_active_unique
    ON vfs_space_mounts(target_folder_id, item_type, item_id)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_vfs_space_mounts_space
    ON vfs_space_mounts(space_id)
    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_vfs_space_mounts_folder
    ON vfs_space_mounts(target_folder_id)
    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_vfs_space_mounts_item
    ON vfs_space_mounts(item_type, item_id)
    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_vfs_space_mounts_local_version
    ON vfs_space_mounts(local_version);
CREATE INDEX IF NOT EXISTS idx_vfs_space_mounts_deleted_at
    ON vfs_space_mounts(deleted_at);
CREATE INDEX IF NOT EXISTS idx_vfs_space_mounts_device_version
    ON vfs_space_mounts(device_id, local_version);
CREATE INDEX IF NOT EXISTS idx_vfs_space_mounts_updated_active
    ON vfs_space_mounts(updated_at)
    WHERE deleted_at IS NULL;

CREATE TRIGGER IF NOT EXISTS trg__change_log_vfs_space_mounts_insert
AFTER INSERT ON vfs_space_mounts
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('vfs_space_mounts', NEW.id, 'INSERT');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_vfs_space_mounts_update
AFTER UPDATE ON vfs_space_mounts
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('vfs_space_mounts', NEW.id, 'UPDATE');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_vfs_space_mounts_delete
AFTER DELETE ON vfs_space_mounts
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('vfs_space_mounts', OLD.id, 'DELETE');
END;

-- 3. Directed semantic backlink edges across PDF, Media, Notes, MindMaps, Flashcards, and QBank
CREATE TABLE IF NOT EXISTS vfs_anchor_edges (
    edge_id            TEXT PRIMARY KEY,
    source_kind        TEXT NOT NULL,
    source_resource_id TEXT NOT NULL,
    source_sub_id      TEXT NOT NULL DEFAULT '',
    source_anchor_uri  TEXT NOT NULL,
    source_label       TEXT NOT NULL DEFAULT '',
    target_kind        TEXT NOT NULL,
    target_resource_id TEXT NOT NULL,
    target_locator_key TEXT NOT NULL DEFAULT '',
    target_page        INTEGER,
    target_start_ms    INTEGER,
    target_end_ms      INTEGER,
    target_rect_json   TEXT,
    target_anchor_uri  TEXT NOT NULL,
    study_space_id     TEXT,
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vfs_anchor_edges_target
    ON vfs_anchor_edges (target_resource_id, target_kind, target_page, target_start_ms);

CREATE INDEX IF NOT EXISTS idx_vfs_anchor_edges_source
    ON vfs_anchor_edges (source_kind, source_resource_id, source_sub_id);

CREATE TRIGGER IF NOT EXISTS trg__change_log_vfs_anchor_edges_insert
AFTER INSERT ON vfs_anchor_edges
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('vfs_anchor_edges', NEW.edge_id, 'INSERT');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_vfs_anchor_edges_update
AFTER UPDATE ON vfs_anchor_edges
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('vfs_anchor_edges', NEW.edge_id, 'UPDATE');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_vfs_anchor_edges_delete
AFTER DELETE ON vfs_anchor_edges
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('vfs_anchor_edges', OLD.edge_id, 'DELETE');
END;
