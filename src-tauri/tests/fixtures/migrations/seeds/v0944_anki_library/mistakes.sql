-- Fixture seed: mistakes.db from v0.9.44 (schema V20260724).
--
-- The first card models historical/imported optional JSON columns stored as
-- NULL. The second proves critic and image-occlusion metadata survives the
-- normalization migration without being rewritten.

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
    'card_v0944_null_json', 'task_v0944_anki_1', 'Legacy nullable card', 'Still readable',
    NULL, NULL, '2026-08-09T08:01:00Z', '2026-08-09T08:01:00Z',
    NULL, '', ''
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
