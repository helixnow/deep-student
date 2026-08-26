-- Fixture seed: mistakes.db from v0.9.44 (schema V20260724).
--
-- The first card models historical/imported optional JSON columns stored as
-- NULL. The second proves critic and image-occlusion metadata survives the
-- normalization migration without being rewritten.
--
-- The remaining cards model the real v0.9.44 legacy shape the V20260824
-- normalization exists for: rows whose source_type/source_id are truly NULL.
-- SQLite treats NULL unique-index keys as pairwise distinct, so a legacy
-- library can hold several live cards with identical content and NULL
-- sources; normalizing NULL -> '' makes those keys collide, which used to
-- abort the whole migration with a UNIQUE constraint failure. The seed plants
-- a NULL/NULL collision pair plus a mixed pair (an old ''-source row vs a
-- newer NULL-source row) so the dedup sweep is exercised end to end.
--
-- Early runtime-created tables predate the NOT NULL constraint on
-- source_type/source_id, but the fixture harness replays the consolidated
-- migrations, whose table shape at HEAD must stay byte-identical to a fresh
-- install. To plant NULL data without diverging the declared schema, the
-- constraint is lifted via writable_schema only around the INSERTs and then
-- restored verbatim; the migration itself probes NULLs with typeof() so it
-- repairs the data in both worlds.

INSERT INTO document_tasks (
    id, document_id, original_document_name, segment_index, content_segment,
    status, created_at, updated_at, anki_generation_options_json
) VALUES (
    'task_v0944_anki_1', 'doc_v0944_anki_1', 'v0.9.44 cards', 0, 'legacy material',
    'Completed', '2026-08-09T08:00:00Z', '2026-08-09T08:00:00Z', '{}'
);

INSERT INTO anki_cards (
    id, task_id, front, back, tags_json, images_json, created_at, updated_at,
    extra_fields_json, source_type, source_id
) VALUES (
    'card_v0944_qa_occlusion', 'task_v0944_anki_1', 'Identify the masked region', 'Left atrium',
    '["image_occlusion"]', '["heart.png"]',
    '2026-08-09T08:02:00Z', '2026-08-09T08:02:00Z',
    '{"_qa_flags":"[{\"severity\":\"warn\",\"rule\":\"maxLength\",\"message\":\"review wording\"}]","_occlusion":"{\"imageRef\":\"heart.png\",\"boxes\":[{\"x\":10,\"y\":20,\"width\":30,\"height\":40,\"clozeIndex\":1,\"label\":\"Left atrium\"}]}"}',
    'document', 'doc_v0944_anki_1'
);

-- ---------------------------------------------------------------------------
-- Lift NOT NULL on source_type/source_id (legacy runtime table shape) just
-- long enough to insert genuinely NULL source rows, then restore the exact
-- consolidated declaration so the HEAD schema snapshot stays byte-identical.
-- ---------------------------------------------------------------------------
PRAGMA writable_schema = ON;
UPDATE sqlite_master
SET sql = replace(replace(sql,
    'source_type TEXT NOT NULL', 'source_type TEXT'),
    'source_id TEXT NOT NULL', 'source_id TEXT')
WHERE type = 'table' AND name = 'anki_cards';
PRAGMA writable_schema = RESET;

-- True NULL-source card with NULL optional JSON columns (unique content, no
-- collision): must survive with sources normalized to ''.
INSERT INTO anki_cards (
    id, task_id, front, back, tags_json, images_json, created_at, updated_at,
    extra_fields_json, source_type, source_id
) VALUES (
    'card_v0944_null_json', 'task_v0944_anki_1', 'Legacy nullable card', 'Still readable',
    NULL, NULL, '2026-08-09T08:01:00Z', '2026-08-09T08:01:00Z',
    NULL, NULL, NULL
);

-- Collision pair: identical content, both sources NULL, both live. After
-- NULL -> '' both rows land on the same dedup key; the newer row must stay
-- live and the older one must be tombstoned instead of failing the upgrade.
INSERT INTO anki_cards (
    id, task_id, front, back, tags_json, images_json, created_at, updated_at,
    extra_fields_json, source_type, source_id
) VALUES (
    'card_v0944_null_dup_old', 'task_v0944_anki_1', 'Duplicated legacy front', 'Duplicated legacy back',
    NULL, NULL, '2026-08-09T08:03:00Z', '2026-08-09T08:03:00Z',
    NULL, NULL, NULL
);
INSERT INTO anki_cards (
    id, task_id, front, back, tags_json, images_json, created_at, updated_at,
    extra_fields_json, source_type, source_id
) VALUES (
    'card_v0944_null_dup_new', 'task_v0944_anki_1', 'Duplicated legacy front', 'Duplicated legacy back',
    '["keep"]', '[]', '2026-08-09T08:04:00Z', '2026-08-09T08:05:00Z',
    '{}', NULL, NULL
);

-- Mixed pair: an already-normalized ''-source row coexists with a newer
-- NULL-source twin. The newer row wins regardless of which side was NULL.
INSERT INTO anki_cards (
    id, task_id, front, back, tags_json, images_json, created_at, updated_at,
    extra_fields_json, source_type, source_id
) VALUES (
    'card_v0944_mixed_lose', 'task_v0944_anki_1', 'Mixed source front', 'Mixed source back',
    '[]', '[]', '2026-08-09T08:06:00Z', '2026-08-09T08:06:00Z',
    '{}', '', ''
);
INSERT INTO anki_cards (
    id, task_id, front, back, tags_json, images_json, created_at, updated_at,
    extra_fields_json, source_type, source_id
) VALUES (
    'card_v0944_mixed_keep', 'task_v0944_anki_1', 'Mixed source front', 'Mixed source back',
    '["fresh"]', '[]', '2026-08-09T08:07:00Z', '2026-08-09T08:08:00Z',
    '{}', NULL, ''
);

PRAGMA writable_schema = ON;
UPDATE sqlite_master
SET sql = replace(replace(sql,
    'source_type TEXT DEFAULT', 'source_type TEXT NOT NULL DEFAULT'),
    'source_id TEXT DEFAULT', 'source_id TEXT NOT NULL DEFAULT')
WHERE type = 'table' AND name = 'anki_cards';
PRAGMA writable_schema = RESET;
