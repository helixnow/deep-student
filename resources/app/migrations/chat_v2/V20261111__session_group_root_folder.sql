-- Promote implicit first pinned fld_* entry on chat_v2_session_groups to explicit root_folder_id.
-- @danger-ack: add_column_backfill reason="Deterministic backfill of root_folder_id from first fld_* entry in pinned_resource_ids_json where root_folder_id IS NULL"

ALTER TABLE chat_v2_session_groups ADD COLUMN root_folder_id TEXT;

CREATE INDEX IF NOT EXISTS idx_session_groups_root_folder
    ON chat_v2_session_groups(root_folder_id)
    WHERE deleted_at IS NULL AND root_folder_id IS NOT NULL;

-- Deterministic backfill from pinned_resource_ids_json first fld_* entry
UPDATE chat_v2_session_groups
SET root_folder_id = (
    SELECT CAST(je.value AS TEXT)
    FROM json_each(
        CASE
            WHEN json_valid(chat_v2_session_groups.pinned_resource_ids_json) THEN
                CASE
                    WHEN json_type(chat_v2_session_groups.pinned_resource_ids_json) = 'array'
                    THEN chat_v2_session_groups.pinned_resource_ids_json
                    ELSE '[]'
                END
            ELSE '[]'
        END
    ) AS je
    WHERE typeof(je.value) = 'text'
      AND CAST(je.value AS TEXT) LIKE 'fld_%'
    ORDER BY je.key ASC
    LIMIT 1
)
WHERE root_folder_id IS NULL;
