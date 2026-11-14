-- ============================================================================
-- V20260502: Reinterpret legacy deleted Chat V2 sessions as archived
-- ============================================================================
--
-- Older Chat V2 builds used persist_status = 'deleted' for the session trash.
-- The current model uses active / archived / permanent delete. Preserve user
-- data by moving legacy trash entries into the recoverable archive instead of
-- physically deleting them.
--
-- Keep updated_at unchanged so archived-session ordering still reflects the
-- original session activity/resting time rather than upgrade time.
-- ============================================================================

UPDATE chat_v2_sessions
SET persist_status = 'archived'
WHERE persist_status = 'deleted';
