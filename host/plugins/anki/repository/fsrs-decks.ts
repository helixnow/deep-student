/**
 * anki_decks 的 L16 owner 写接缝，供 L15 review 传原 conn/tx 消费。
 * Rust `fsrs_review_service.rs:1346-1352,3640,3686`；不开事务、不取得新连接。
 * 只抛底层存储错误，由 L15 保留原 Database 前缀包装，避免双包。
 */
import type { SqlExecutor } from '../../../platform/storage/api.ts';

export function ensureDefaultFsrsDeckWithConn(conn: SqlExecutor, now: string): void {
  conn.run(
    `INSERT OR IGNORE INTO anki_decks (id, name, description, config_json, created_at, updated_at, local_version)
     VALUES (?1, 'Default', 'Default flashcard deck for FSRS reviews', '{"desired_retention":0.9}', ?2, ?2, 0)`,
    ['deck_default', now],
  );
}

export function writeFsrsDeckConfigWithConn(
  conn: SqlExecutor,
  deckId: string,
  configJson: string,
  now: string,
): void {
  conn.run(
    `UPDATE anki_decks SET config_json = ?1, updated_at = ?2,
     local_version = COALESCE(local_version, 0) + 1 WHERE id = ?3 AND deleted_at IS NULL`,
    [configJson, now, deckId],
  );
}
