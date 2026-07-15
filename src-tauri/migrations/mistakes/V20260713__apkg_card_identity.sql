-- APKG contains one `cards` row per rendered/scheduled card, so several rows can
-- legitimately share the same note fields. Preserve the existing content-based
-- deduplication for generated cards while giving imported APKG rows card identity.

DROP INDEX IF EXISTS idx_anki_cards_dedup_unique;

CREATE UNIQUE INDEX idx_anki_cards_dedup_unique
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
WHERE is_error_card = 0;
