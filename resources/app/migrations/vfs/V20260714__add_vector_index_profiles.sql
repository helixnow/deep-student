-- Vector index identity and generation metadata.
--
-- Keep vfs_embedding_dims as the compatibility registry while introducing an
-- explicit profile identity.  Existing vectors are backfilled into a legacy
-- profile and must be rebuilt before their model binding can change.

CREATE TABLE IF NOT EXISTS vfs_index_profiles (
    id TEXT PRIMARY KEY,
    model_fingerprint TEXT NOT NULL,
    model_config_id TEXT,
    model_name TEXT,
    dimension INTEGER NOT NULL,
    modality TEXT NOT NULL,
    embedding_protocol TEXT NOT NULL,
    schema_version INTEGER NOT NULL DEFAULT 1,
    lance_table_name TEXT NOT NULL,
    -- Compatibility metadata only. Query visibility is governed by each
    -- vfs_index_unit's modality-specific generation, never this profile value.
    active_generation INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'active',
    ann_metric TEXT NOT NULL DEFAULT 'exact',
    ann_index_version INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (dimension BETWEEN 64 AND 8192),
    CHECK (modality IN ('text', 'image', 'multimodal')),
    CHECK (active_generation >= 0),
    UNIQUE (model_fingerprint, dimension, modality, embedding_protocol, schema_version)
);

ALTER TABLE vfs_embedding_dims ADD COLUMN active_profile_id TEXT;
ALTER TABLE vfs_embedding_dims ADD COLUMN model_fingerprint TEXT;
ALTER TABLE vfs_embedding_dims ADD COLUMN embedding_protocol TEXT NOT NULL DEFAULT 'legacy';
-- Compatibility metadata only; per-Unit generations are authoritative.
ALTER TABLE vfs_embedding_dims ADD COLUMN active_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE vfs_embedding_dims ADD COLUMN ann_metric TEXT NOT NULL DEFAULT 'legacy_l2';
ALTER TABLE vfs_embedding_dims ADD COLUMN ann_index_version INTEGER NOT NULL DEFAULT 0;

ALTER TABLE vfs_index_units ADD COLUMN text_profile_id TEXT;
ALTER TABLE vfs_index_units ADD COLUMN text_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE vfs_index_units ADD COLUMN mm_profile_id TEXT;
ALTER TABLE vfs_index_units ADD COLUMN mm_generation INTEGER NOT NULL DEFAULT 0;

ALTER TABLE vfs_index_segments ADD COLUMN index_profile_id TEXT;
ALTER TABLE vfs_index_segments ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;

ALTER TABLE resources ADD COLUMN index_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE resources ADD COLUMN mm_index_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE resources ADD COLUMN index_next_retry_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE resources ADD COLUMN mm_index_next_retry_at INTEGER NOT NULL DEFAULT 0;

ALTER TABLE __lance_orphan_queue ADD COLUMN next_retry_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE __lance_orphan_queue ADD COLUMN last_error TEXT;

INSERT OR IGNORE INTO vfs_index_profiles (
    id, model_fingerprint, model_config_id, model_name, dimension, modality,
    embedding_protocol, schema_version, lance_table_name, active_generation,
    state, ann_metric, ann_index_version, created_at, updated_at
)
SELECT
    'profile_legacy_' || modality || '_' || dimension,
    CASE
        WHEN model_config_id IS NOT NULL AND model_config_id <> ''
            THEN 'legacy:model-config:' || model_config_id
        ELSE 'legacy:unbound:' || modality || ':' || dimension
    END,
    model_config_id,
    model_name,
    dimension,
    modality,
    CASE WHEN modality IN ('image', 'multimodal')
        THEN 'multimodal-embedding-v1'
        ELSE 'text-embedding-v1'
    END,
    1,
    lance_table_name,
    0,
    'active',
    CASE WHEN record_count > 0 THEN 'legacy_l2' ELSE 'exact' END,
    0,
    created_at,
    last_used_at
FROM vfs_embedding_dims;

-- Earlier development drafts classified image embeddings as text embeddings.
-- Only legacy rows are rewritten; profiles created by the current application
-- retain their explicit protocol binding.
UPDATE vfs_index_profiles
SET embedding_protocol = CASE WHEN modality IN ('image', 'multimodal')
        THEN 'multimodal-embedding-v1'
        ELSE 'text-embedding-v1'
    END
WHERE id = 'profile_legacy_' || modality || '_' || dimension;

UPDATE vfs_embedding_dims
SET model_fingerprint = CASE WHEN active_profile_id IS NULL
        OR active_profile_id = 'profile_legacy_' || modality || '_' || dimension THEN
        CASE
            WHEN model_config_id IS NOT NULL AND model_config_id <> ''
                THEN 'legacy:model-config:' || model_config_id
            ELSE 'legacy:unbound:' || modality || ':' || dimension
        END
        ELSE model_fingerprint
    END,
    embedding_protocol = CASE WHEN active_profile_id IS NULL
        OR active_profile_id = 'profile_legacy_' || modality || '_' || dimension THEN
        CASE WHEN modality IN ('image', 'multimodal')
            THEN 'multimodal-embedding-v1'
            ELSE 'text-embedding-v1'
        END
        ELSE embedding_protocol
    END,
    ann_metric = CASE WHEN active_profile_id IS NULL
        OR active_profile_id = 'profile_legacy_' || modality || '_' || dimension THEN
        CASE WHEN record_count > 0 THEN 'legacy_l2' ELSE 'exact' END
        ELSE ann_metric
    END,
    active_profile_id = COALESCE(
        active_profile_id,
        'profile_legacy_' || modality || '_' || dimension
    );

UPDATE vfs_index_segments
SET index_profile_id = (
        SELECT d.active_profile_id
        FROM vfs_embedding_dims d
        WHERE d.dimension = vfs_index_segments.embedding_dim
          AND d.modality = vfs_index_segments.modality
    ),
    generation = 0
WHERE index_profile_id IS NULL;

UPDATE vfs_index_units
SET text_profile_id = COALESCE(
        text_profile_id,
        (
            SELECT d.active_profile_id
            FROM vfs_embedding_dims d
            WHERE d.dimension = vfs_index_units.text_embedding_dim
              AND d.modality = 'text'
        )
    ),
    mm_profile_id = COALESCE(
        mm_profile_id,
        (
            SELECT d.active_profile_id
            FROM vfs_embedding_dims d
            WHERE d.dimension = vfs_index_units.mm_embedding_dim
              AND d.modality IN ('multimodal', 'image')
            ORDER BY CASE d.modality WHEN 'multimodal' THEN 0 ELSE 1 END
            LIMIT 1
        )
    )
WHERE text_profile_id IS NULL OR mm_profile_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_vfs_index_profiles_route
    ON vfs_index_profiles(modality, dimension, state);
CREATE INDEX IF NOT EXISTS idx_vfs_index_profiles_model
    ON vfs_index_profiles(model_config_id, state);
CREATE INDEX IF NOT EXISTS idx_vfs_index_segments_profile_generation
    ON vfs_index_segments(index_profile_id, generation);
CREATE INDEX IF NOT EXISTS idx_vfs_index_units_text_profile
    ON vfs_index_units(text_profile_id, text_generation);
CREATE INDEX IF NOT EXISTS idx_vfs_index_units_mm_profile
    ON vfs_index_units(mm_profile_id, mm_generation);
CREATE INDEX IF NOT EXISTS idx_resources_index_retry_due
    ON resources(index_state, index_next_retry_at);
CREATE INDEX IF NOT EXISTS idx_resources_mm_index_retry_due
    ON resources(mm_index_state, mm_index_next_retry_at);
CREATE INDEX IF NOT EXISTS idx_lance_orphan_retry_due
    ON __lance_orphan_queue(next_retry_at, enqueued_at);

-- Existing Lance rows are readable as generation 0, but must be rebuilt so
-- unit/profile provenance and the explicit cosine ANN index are materialized.
UPDATE resources
SET index_state = CASE WHEN index_state = 'disabled' THEN 'disabled' ELSE 'pending' END,
    mm_index_state = CASE
        WHEN mm_index_state IS NULL THEN NULL
        WHEN mm_index_state = 'disabled' THEN 'disabled'
        ELSE 'pending'
    END,
    index_error = NULL,
    index_retry_count = 0,
    index_next_retry_at = 0,
    mm_index_error = NULL,
    mm_index_retry_count = 0,
    mm_index_next_retry_at = 0;

UPDATE vfs_index_units
SET text_state = CASE WHEN text_required = 1 THEN 'pending' ELSE 'disabled' END,
    mm_state = CASE WHEN mm_required = 1 THEN 'pending' ELSE 'disabled' END,
    text_error = NULL,
    mm_error = NULL;
