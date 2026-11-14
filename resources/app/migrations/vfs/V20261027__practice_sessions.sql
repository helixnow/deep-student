CREATE TABLE IF NOT EXISTS qbank_papers (
    id TEXT PRIMARY KEY,
    exam_id TEXT NOT NULL,
    title TEXT NOT NULL,
    document_json TEXT NOT NULL,
    local_version INTEGER NOT NULL DEFAULT 1,
    sync_version INTEGER NOT NULL DEFAULT 0,
    device_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    deletion_batch TEXT
);
CREATE INDEX IF NOT EXISTS idx_qbank_papers_exam ON qbank_papers(exam_id, deleted_at, created_at);

-- Drafts and grading jobs belong to this device; neither enters RowSync.
CREATE TABLE IF NOT EXISTS qbank_practice_drafts (
    id TEXT PRIMARY KEY,
    scope_id TEXT NOT NULL,
    paper_id TEXT,
    document_json TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qbank_practice_drafts_scope ON qbank_practice_drafts(scope_id, updated_at);

CREATE TABLE IF NOT EXISTS qbank_practice_attempts (
    id TEXT PRIMARY KEY,
    scope_id TEXT NOT NULL,
    paper_id TEXT,
    document_json TEXT NOT NULL,
    local_version INTEGER NOT NULL DEFAULT 1,
    sync_version INTEGER NOT NULL DEFAULT 0,
    device_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    deletion_batch TEXT
);
CREATE INDEX IF NOT EXISTS idx_qbank_practice_attempts_scope ON qbank_practice_attempts(scope_id, deleted_at, created_at);
CREATE INDEX IF NOT EXISTS idx_qbank_practice_attempts_paper ON qbank_practice_attempts(paper_id, deleted_at);

CREATE TABLE IF NOT EXISTS qbank_practice_jobs (
    id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL REFERENCES qbank_practice_attempts(id) ON DELETE CASCADE,
    question_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'done', 'failed')),
    error TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE(attempt_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_qbank_practice_jobs_status ON qbank_practice_jobs(status, updated_at);

CREATE TRIGGER IF NOT EXISTS qbank_papers_insert AFTER INSERT ON qbank_papers BEGIN
    INSERT INTO __change_log(table_name,record_id,operation) VALUES('qbank_papers',NEW.id,'INSERT');
END;
CREATE TRIGGER IF NOT EXISTS qbank_papers_update AFTER UPDATE ON qbank_papers BEGIN
    INSERT INTO __change_log(table_name,record_id,operation) VALUES('qbank_papers',NEW.id,'UPDATE');
END;
CREATE TRIGGER IF NOT EXISTS qbank_papers_delete AFTER DELETE ON qbank_papers BEGIN
    INSERT INTO __change_log(table_name,record_id,operation) VALUES('qbank_papers',OLD.id,'DELETE');
END;
CREATE TRIGGER IF NOT EXISTS qbank_practice_attempts_insert AFTER INSERT ON qbank_practice_attempts BEGIN
    INSERT INTO __change_log(table_name,record_id,operation) VALUES('qbank_practice_attempts',NEW.id,'INSERT');
END;
CREATE TRIGGER IF NOT EXISTS qbank_practice_attempts_update AFTER UPDATE ON qbank_practice_attempts BEGIN
    INSERT INTO __change_log(table_name,record_id,operation) VALUES('qbank_practice_attempts',NEW.id,'UPDATE');
END;
CREATE TRIGGER IF NOT EXISTS qbank_practice_attempts_delete AFTER DELETE ON qbank_practice_attempts BEGIN
    INSERT INTO __change_log(table_name,record_id,operation) VALUES('qbank_practice_attempts',OLD.id,'DELETE');
END;
