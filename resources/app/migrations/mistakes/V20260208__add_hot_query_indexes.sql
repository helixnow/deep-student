-- ============================================================================
-- V20260208: Add hot query indexes for Anki / Document tasks
-- ============================================================================

-- Document tasks: recent queries and segment ordering
CREATE INDEX IF NOT EXISTS idx_document_tasks_updated_at ON document_tasks(updated_at);
CREATE INDEX IF NOT EXISTS idx_document_tasks_document_segment ON document_tasks(document_id, segment_index);

-- Anki cards: library listing + task ordering
CREATE INDEX IF NOT EXISTS idx_anki_cards_created_at ON anki_cards(created_at);
CREATE INDEX IF NOT EXISTS idx_anki_cards_template_id ON anki_cards(template_id);
CREATE INDEX IF NOT EXISTS idx_anki_cards_task_order ON anki_cards(task_id, card_order_in_task, created_at);
