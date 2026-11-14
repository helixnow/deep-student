-- Rebuild the anki_cards dedup unique index so soft-deleted rows no longer
-- block re-inserting the same content. Without the deleted_at predicate a
-- tombstoned card keeps occupying its dedup key, so regenerating identical
-- content fails with a UNIQUE constraint error.
--
-- Index shape follows V20260713 (apkg_import rows keep per-card identity via
-- id in the CASE arm); only the partial-index predicate gains the
-- deleted_at IS NULL condition. DROP/CREATE are idempotent and safe to rerun.

DROP INDEX IF EXISTS idx_anki_cards_dedup_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_anki_cards_dedup_unique
ON anki_cards(
    source_type,
    source_id,
    CASE
        WHEN source_type = 'apkg_import'
        THEN id
        WHEN text IS NOT NULL AND length(text) > 0
        THEN text
        ELSE printf('%d:%s|%s', length(front), front, back)
    END
)
WHERE is_error_card = 0 AND deleted_at IS NULL;
