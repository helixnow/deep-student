-- ============================================================================
-- V20260709: Flashcard FSRS schema (decks + card states + review logs)
-- ============================================================================
--
-- 为 Anki 闪卡引入独立的 FSRS 调度表，不改动 anki_cards 表结构。
-- 调度状态与复习日志与卡片内容解耦；运行时调度使用 rs-fsrs（见 FSRS_PARAMS_VERSION）。

CREATE TABLE IF NOT EXISTS anki_decks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  config_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  device_id TEXT,
  local_version INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS fsrs_card_states (
  id TEXT PRIMARY KEY,
  anki_card_id TEXT NOT NULL UNIQUE,
  deck_id TEXT,
  state INTEGER NOT NULL DEFAULT 0,
  stability REAL,
  difficulty REAL,
  elapsed_days REAL NOT NULL DEFAULT 0,
  scheduled_days REAL NOT NULL DEFAULT 0,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  due_ms INTEGER NOT NULL,
  last_review_ms INTEGER,
  suspended INTEGER NOT NULL DEFAULT 0,
  fsrs_params_version TEXT NOT NULL DEFAULT 'rs-fsrs-1.2',
  desired_retention REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fsrs_due ON fsrs_card_states(due_ms) WHERE suspended = 0;

CREATE TABLE IF NOT EXISTS fsrs_review_logs (
  id TEXT PRIMARY KEY,
  card_state_id TEXT NOT NULL,
  anki_card_id TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 4),
  state_before INTEGER NOT NULL,
  state_after INTEGER NOT NULL,
  stability_before REAL,
  stability_after REAL,
  difficulty_before REAL,
  difficulty_after REAL,
  scheduled_days REAL,
  elapsed_days REAL,
  due_before_ms INTEGER,
  due_after_ms INTEGER,
  review_ms INTEGER NOT NULL,
  duration_ms INTEGER,
  fsrs_params_version TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fsrs_logs_card ON fsrs_review_logs(anki_card_id, review_ms DESC);

-- Seed: 默认牌组（幂等）
INSERT OR IGNORE INTO anki_decks (
  id, name, description, config_json, created_at, updated_at, local_version
) VALUES (
  'deck_default',
  'Default',
  'Default flashcard deck for FSRS reviews',
  '{"desired_retention":0.9}',
  '2026-07-09T00:00:00Z',
  '2026-07-09T00:00:00Z',
  0
);
