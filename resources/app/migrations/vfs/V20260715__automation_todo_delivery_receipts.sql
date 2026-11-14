-- ============================================================================
-- V20260715: Idempotency receipts for automation-created todo items
-- ============================================================================

CREATE TABLE IF NOT EXISTS automation_todo_deliveries (
    run_id TEXT PRIMARY KEY NOT NULL,
    todo_item_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (todo_item_id) REFERENCES todo_items(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_automation_todo_deliveries_item
    ON automation_todo_deliveries(todo_item_id);
