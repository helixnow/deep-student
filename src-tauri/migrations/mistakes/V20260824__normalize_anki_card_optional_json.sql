-- ============================================================================
-- V20260824: Normalize nullable optional fields in historical Anki cards
-- ============================================================================
--
-- tags_json / images_json / extra_fields_json have always been optional at the
-- SQLite level. Historical writers and synced rows can therefore contain NULL
-- (or an empty string), while current library and FSRS readers expect JSON
-- text. Normalize only missing values; valid extra_fields payloads, including
-- `_qa_flags` and `_occlusion`, must remain byte-for-byte unchanged.

UPDATE anki_cards
SET tags_json = '[]'
WHERE tags_json IS NULL OR trim(tags_json) = '';

UPDATE anki_cards
SET images_json = '[]'
WHERE images_json IS NULL OR trim(images_json) = '';

UPDATE anki_cards
SET extra_fields_json = '{}'
WHERE extra_fields_json IS NULL OR trim(extra_fields_json) = '';

-- source_type/source_id are NOT NULL in the consolidated schema, but early
-- runtime-created tables and imported/synced rows may predate that constraint.
UPDATE anki_cards
SET source_type = ''
WHERE source_type IS NULL;

UPDATE anki_cards
SET source_id = ''
WHERE source_id IS NULL;
