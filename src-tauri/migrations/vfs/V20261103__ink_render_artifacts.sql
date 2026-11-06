-- A global immutable render identity is independent of any Chat session/call.
-- The image file/resource are intentionally not foreign-keyed: deleting the visible file
-- must not delete historical provenance. The blob pin remains directly protected by FK.
CREATE TABLE ink_render_artifacts (
    render_id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL UNIQUE,
    metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
    image_blob_hash TEXT NOT NULL REFERENCES blobs(hash) ON DELETE RESTRICT,
    image_file_id TEXT NOT NULL,
    image_resource_id TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX idx_ink_render_artifacts_blob ON ink_render_artifacts(image_blob_hash);

CREATE TRIGGER trg__change_log_ink_render_artifacts_insert
AFTER INSERT ON ink_render_artifacts BEGIN
    UPDATE blobs SET ref_count = ref_count + 1 WHERE hash = NEW.image_blob_hash;
    INSERT INTO __change_log(table_name, record_id, operation)
    VALUES('ink_render_artifacts', NEW.render_id, 'INSERT');
END;

CREATE TRIGGER trg_ink_render_artifacts_immutable_update
BEFORE UPDATE ON ink_render_artifacts BEGIN
    SELECT RAISE(ABORT, 'ink render artifacts are immutable');
END;

CREATE TRIGGER trg_ink_render_artifacts_immutable_delete
BEFORE DELETE ON ink_render_artifacts BEGIN
    SELECT RAISE(ABORT, 'ink render artifacts are immutable');
END;
