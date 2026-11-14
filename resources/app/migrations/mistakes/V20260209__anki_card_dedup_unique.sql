-- Ensure atomic Anki card deduplication at DB level.
-- 1) Backfill source_type/source_id so document-level scope is available
-- 2) Remove existing duplicates under the new dedup key
-- 3) Add a unique index for non-error cards

UPDATE anki_cards
SET source_type = 'document',
    source_id = (
        SELECT document_id
        FROM document_tasks
        WHERE document_tasks.id = anki_cards.task_id
    )
WHERE (source_type IS NULL OR source_type = '' OR source_id IS NULL OR source_id = '')
  AND EXISTS (
      SELECT 1
      FROM document_tasks
      WHERE document_tasks.id = anki_cards.task_id
  );

UPDATE anki_cards
SET source_type = 'task',
    source_id = task_id
WHERE (source_type IS NULL OR source_type = '' OR source_id IS NULL OR source_id = '');

DELETE FROM anki_cards
WHERE is_error_card = 0
  AND rowid NOT IN (
      SELECT MIN(rowid)
      FROM anki_cards
      WHERE is_error_card = 0
      GROUP BY source_type,
               source_id,
               CASE
                   WHEN text IS NOT NULL AND length(text) > 0
                   THEN text
                   ELSE printf('%d:%s|%s', length(front), front, back)
               END
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_anki_cards_dedup_unique
ON anki_cards(
    source_type,
    source_id,
    CASE
        WHEN text IS NOT NULL AND length(text) > 0
        THEN text
        ELSE printf('%d:%s|%s', length(front), front, back)
    END
)
WHERE is_error_card = 0;
