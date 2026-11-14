-- ============================================================================
-- V20260718: Mastery intermediate layer (A-P0)
-- append-only mastery_events + aggregated mastery_states
-- ============================================================================

CREATE TABLE IF NOT EXISTS mastery_events (
    id TEXT PRIMARY KEY NOT NULL,
    created_at TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('qbank', 'fsrs')),
    concept_key TEXT NOT NULL,
    item_id TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('correct', 'wrong', 'rating')),
    weight REAL NOT NULL DEFAULT 1.0 CHECK (weight >= 0.0 AND weight <= 1.0)
);

CREATE INDEX IF NOT EXISTS idx_mastery_events_concept_time
    ON mastery_events(concept_key, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mastery_events_item_time
    ON mastery_events(item_id, created_at DESC);

CREATE TABLE IF NOT EXISTS mastery_states (
    concept_key TEXT PRIMARY KEY NOT NULL,
    score REAL NOT NULL DEFAULT 0.5 CHECK (score >= 0.0 AND score <= 1.0),
    streak INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    wrong_count INTEGER NOT NULL DEFAULT 0,
    last_signal_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_mastery_states_score
    ON mastery_states(score ASC);
