-- Additive v2 authoring entities. Existing ids, variants and study history stay.
CREATE TABLE qbank_sources (
    id TEXT PRIMARY KEY, exam_id TEXT NOT NULL REFERENCES exam_sheets(id) ON DELETE CASCADE,
    source_key TEXT NOT NULL, descriptor_json TEXT NOT NULL DEFAULT '{}',
    local_version INTEGER NOT NULL DEFAULT 1, sync_version INTEGER NOT NULL DEFAULT 0,
    device_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
    UNIQUE(exam_id,source_key)
);
CREATE TABLE qbank_materials (
    id TEXT PRIMARY KEY, exam_id TEXT NOT NULL REFERENCES exam_sheets(id) ON DELETE CASCADE,
    content TEXT NOT NULL, images_json TEXT NOT NULL DEFAULT '[]', source_refs_json TEXT NOT NULL DEFAULT '[]',
    local_version INTEGER NOT NULL DEFAULT 1, sync_version INTEGER NOT NULL DEFAULT 0,
    device_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, deletion_batch TEXT,
    UNIQUE(id,exam_id)
);
CREATE TABLE qbank_groups (
    id TEXT PRIMARY KEY, exam_id TEXT NOT NULL REFERENCES exam_sheets(id) ON DELETE CASCADE,
    label TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0,
    local_version INTEGER NOT NULL DEFAULT 1, sync_version INTEGER NOT NULL DEFAULT 0,
    device_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, deletion_batch TEXT,
    UNIQUE(id,exam_id)
);
CREATE TABLE qbank_group_materials (
    id TEXT PRIMARY KEY, exam_id TEXT NOT NULL REFERENCES exam_sheets(id) ON DELETE CASCADE,
    group_id TEXT NOT NULL, material_id TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0,
    local_version INTEGER NOT NULL DEFAULT 1, sync_version INTEGER NOT NULL DEFAULT 0,
    device_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, deletion_batch TEXT,
    FOREIGN KEY(group_id,exam_id) REFERENCES qbank_groups(id,exam_id) ON DELETE CASCADE,
    FOREIGN KEY(material_id,exam_id) REFERENCES qbank_materials(id,exam_id) ON DELETE CASCADE,
    UNIQUE(group_id,material_id)
);
CREATE TABLE qbank_import_jobs (
    id TEXT PRIMARY KEY, exam_id TEXT NOT NULL REFERENCES exam_sheets(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK(status IN ('ready','needs_review','partial','failed','cancelled','committed')),
    version INTEGER NOT NULL DEFAULT 1, document_json TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}', receipt_json TEXT,
    idempotency_key TEXT, selected_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(exam_id,idempotency_key)
);
ALTER TABLE questions ADD COLUMN group_id TEXT REFERENCES qbank_groups(id);
ALTER TABLE questions ADD COLUMN group_position INTEGER;
ALTER TABLE questions ADD COLUMN source_key TEXT;
ALTER TABLE questions ADD COLUMN provenance_json TEXT;
ALTER TABLE questions ADD COLUMN answer_origin TEXT;
ALTER TABLE questions ADD COLUMN deletion_batch TEXT;
ALTER TABLE exam_sheets ADD COLUMN deletion_batch TEXT;
ALTER TABLE answer_submissions ADD COLUMN question_snapshot_json TEXT;
ALTER TABLE answer_submissions ADD COLUMN material_snapshot_json TEXT;
ALTER TABLE qbank_generation_tasks ADD COLUMN authoring_result_json TEXT;
CREATE INDEX idx_qbank_sources_exam ON qbank_sources(exam_id);
CREATE INDEX idx_qbank_materials_exam ON qbank_materials(exam_id,deleted_at);
CREATE INDEX idx_qbank_groups_exam ON qbank_groups(exam_id,deleted_at,position);
CREATE INDEX idx_qbank_group_materials_group ON qbank_group_materials(group_id,deleted_at,position);
CREATE INDEX idx_qbank_jobs_exam ON qbank_import_jobs(exam_id,status);
CREATE INDEX idx_questions_group ON questions(group_id,group_position);
-- @danger-ack: unique_constraint reason="source_key is a newly added nullable column; all existing rows are NULL and excluded by the partial index, with no data backfill"
CREATE UNIQUE INDEX idx_questions_source_slot ON questions(exam_id,source_key) WHERE source_key IS NOT NULL;

CREATE TRIGGER qbank_question_group_insert BEFORE INSERT ON questions WHEN NEW.group_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM qbank_groups g WHERE g.id=NEW.group_id AND g.exam_id=NEW.exam_id)
    THEN RAISE(ABORT,'question group must belong to same exam') END;
END;
CREATE TRIGGER qbank_question_group_update BEFORE UPDATE OF group_id,exam_id ON questions WHEN NEW.group_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM qbank_groups g WHERE g.id=NEW.group_id AND g.exam_id=NEW.exam_id)
    THEN RAISE(ABORT,'question group must belong to same exam') END;
END;
CREATE TRIGGER qbank_sources_insert AFTER INSERT ON qbank_sources BEGIN INSERT INTO __change_log(table_name,record_id,operation) VALUES('qbank_sources',NEW.id,'INSERT'); END;
CREATE TRIGGER qbank_sources_update AFTER UPDATE ON qbank_sources BEGIN INSERT INTO __change_log(table_name,record_id,operation) VALUES('qbank_sources',NEW.id,'UPDATE'); END;
CREATE TRIGGER qbank_sources_delete AFTER DELETE ON qbank_sources BEGIN INSERT INTO __change_log(table_name,record_id,operation) VALUES('qbank_sources',OLD.id,'DELETE'); END;
CREATE TRIGGER qbank_materials_insert AFTER INSERT ON qbank_materials BEGIN INSERT INTO __change_log(table_name,record_id,operation) VALUES('qbank_materials',NEW.id,'INSERT'); END;
CREATE TRIGGER qbank_materials_update AFTER UPDATE ON qbank_materials BEGIN INSERT INTO __change_log(table_name,record_id,operation) VALUES('qbank_materials',NEW.id,'UPDATE'); END;
CREATE TRIGGER qbank_materials_delete AFTER DELETE ON qbank_materials BEGIN INSERT INTO __change_log(table_name,record_id,operation) VALUES('qbank_materials',OLD.id,'DELETE'); END;
CREATE TRIGGER qbank_groups_insert AFTER INSERT ON qbank_groups BEGIN INSERT INTO __change_log(table_name,record_id,operation) VALUES('qbank_groups',NEW.id,'INSERT'); END;
CREATE TRIGGER qbank_groups_update AFTER UPDATE ON qbank_groups BEGIN INSERT INTO __change_log(table_name,record_id,operation) VALUES('qbank_groups',NEW.id,'UPDATE'); END;
CREATE TRIGGER qbank_groups_delete AFTER DELETE ON qbank_groups BEGIN INSERT INTO __change_log(table_name,record_id,operation) VALUES('qbank_groups',OLD.id,'DELETE'); END;
CREATE TRIGGER qbank_group_materials_insert AFTER INSERT ON qbank_group_materials BEGIN INSERT INTO __change_log(table_name,record_id,operation) VALUES('qbank_group_materials',NEW.id,'INSERT'); END;
CREATE TRIGGER qbank_group_materials_update AFTER UPDATE ON qbank_group_materials BEGIN INSERT INTO __change_log(table_name,record_id,operation) VALUES('qbank_group_materials',NEW.id,'UPDATE'); END;
CREATE TRIGGER qbank_group_materials_delete AFTER DELETE ON qbank_group_materials BEGIN INSERT INTO __change_log(table_name,record_id,operation) VALUES('qbank_group_materials',OLD.id,'DELETE'); END;
