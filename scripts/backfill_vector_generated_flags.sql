-- Backfill vector_generated flag based on embedding existence
-- Sets vector_generated = 1 where embedding is not NULL, 0 otherwise
UPDATE kg_tags
SET vector_generated = CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END; 