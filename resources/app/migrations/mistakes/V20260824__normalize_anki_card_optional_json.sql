-- ============================================================================
-- V20260824: Normalize nullable optional fields in historical Anki cards
-- ============================================================================
--
-- tags_json / images_json / extra_fields_json have always been optional at the
-- SQLite level. Historical writers and synced rows can therefore contain NULL
-- (or an empty string), while current library and FSRS readers expect JSON
-- text. Normalize only missing values; valid extra_fields payloads, including
-- `_qa_flags` and `_occlusion`, must remain byte-for-byte unchanged.
--
-- source_type/source_id are NOT NULL in the consolidated schema, but early
-- runtime-created tables and imported/synced rows may predate that constraint.
-- Normalizing NULL -> '' can collide with the dedup unique index
-- idx_anki_cards_dedup_unique (V20260724 shape): UNIQUE(source_type,
-- source_id, CASE ...) WHERE is_error_card = 0 AND deleted_at IS NULL.
-- SQLite treats NULL index keys as pairwise distinct, so a legacy library can
-- legally hold several live rows whose dedup keys only become equal after
-- normalization; rewriting the second such row would abort the whole upgrade
-- with a UNIQUE constraint failure. Sweep those collisions first: within each
-- post-normalization key, keep the newest live row and tombstone the rest
-- (soft delete via deleted_at, mirroring the app's own dedup semantics).
--
-- NULL probes on source_type/source_id use typeof(...) = 'null' instead of
-- IS NULL: some historical databases carry NULL data underneath a NOT NULL
-- column declaration, and SQLite constant-folds `col IS NULL` to false for
-- declared NOT NULL columns, which would silently skip exactly the rows this
-- migration exists to repair. typeof() and COALESCE() always observe the
-- stored value. updated_at is intentionally left untouched so field-level
-- sync merge never lets this repair win over newer remote writes.

UPDATE anki_cards
SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    source_type = COALESCE(source_type, ''),
    source_id = COALESCE(source_id, '')
WHERE id IN (
    WITH live AS (
        SELECT id,
               updated_at,
               created_at,
               COALESCE(source_type, '') AS norm_source_type,
               COALESCE(source_id, '') AS norm_source_id,
               CASE
                   WHEN COALESCE(source_type, '') = 'apkg_import' THEN id
                   WHEN text IS NOT NULL AND length(text) > 0 THEN text
                   ELSE printf('%d:%s|%s', length(front), front, back)
               END AS dedup_key,
               (typeof(source_type) = 'null' OR typeof(source_id) = 'null')
                   AS has_null_source
        FROM anki_cards
        WHERE is_error_card = 0 AND deleted_at IS NULL
    ),
    ranked AS (
        SELECT id,
               ROW_NUMBER() OVER (
                   PARTITION BY norm_source_type, norm_source_id, dedup_key
                   ORDER BY updated_at DESC, created_at DESC, id DESC
               ) AS keep_rank,
               COUNT(*) OVER (
                   PARTITION BY norm_source_type, norm_source_id, dedup_key
               ) AS group_size,
               SUM(has_null_source) OVER (
                   PARTITION BY norm_source_type, norm_source_id, dedup_key
               ) AS null_source_rows
        FROM live
    )
    -- Only groups the normalization itself would collide (they contain at
    -- least one NULL-source row); pre-existing anomalies stay untouched.
    SELECT id
    FROM ranked
    WHERE group_size > 1
      AND null_source_rows > 0
      AND keep_rank > 1
);

UPDATE anki_cards
SET source_type = COALESCE(source_type, ''),
    source_id = COALESCE(source_id, '')
WHERE typeof(source_type) = 'null'
   OR typeof(source_id) = 'null';

UPDATE anki_cards
SET tags_json = '[]'
WHERE tags_json IS NULL OR trim(tags_json) = '';

UPDATE anki_cards
SET images_json = '[]'
WHERE images_json IS NULL OR trim(images_json) = '';

UPDATE anki_cards
SET extra_fields_json = '{}'
WHERE extra_fields_json IS NULL OR trim(extra_fields_json) = '';
