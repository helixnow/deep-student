// Port of dstu-browser/src/browser/repository.rs: stateless browser persistence.
// Sessions, navigation history, settings and site permissions share the browser.db schema.

import { randomUUID } from 'node:crypto';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { BrowserDatabase } from '../src/database.ts';
import { browserNotFound, browserValidation, databaseOperation } from '../src/error.ts';
import { MAX_HISTORY } from '../src/session.ts';
import { nowTimestamp } from '../src/time.ts';
import type {
  BrowserHistoryPush, BrowserHistoryRow, BrowserSessionRow, BrowserSessionUpsert,
  BrowserSettingRow, SitePermissionRow, SitePermissionUpsert,
} from '../src/types.ts';

interface SessionDbRow {
  id: string;
  profile_id: string;
  title: string | null;
  current_url: string | null;
  favicon_url: string | null;
  user_agent_override: string | null;
  history_index: number;
  is_active: number;
  last_focused_at: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

interface HistoryDbRow {
  id: string;
  session_id: string | null;
  url: string;
  title: string | null;
  seq: number | null;
  visit_count: number;
  typed_count: number;
  last_visit_at: string;
  first_visit_at: string;
  transition: string | null;
  hidden: number;
}

interface SettingDbRow {
  key: string;
  value: string;
  updated_at: string;
}

interface PermissionDbRow {
  id: string;
  origin: string;
  permission: string;
  decision: string;
  scope: string;
  source: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

const SESSION_COLUMNS = `id, profile_id, title, current_url, favicon_url,
  user_agent_override, history_index, is_active, last_focused_at,
  created_at, updated_at, closed_at`;
const HISTORY_COLUMNS = `id, session_id, url, title, seq, visit_count, typed_count,
  last_visit_at, first_visit_at, transition, hidden`;
const PERMISSION_COLUMNS = `id, origin, permission, decision, scope, source,
  expires_at, created_at, updated_at`;

function mapSession(row: SessionDbRow): BrowserSessionRow {
  return {
    id: row.id,
    profileId: row.profile_id,
    title: row.title,
    currentUrl: row.current_url,
    faviconUrl: row.favicon_url,
    userAgentOverride: row.user_agent_override,
    historyIndex: row.history_index,
    isActive: row.is_active !== 0,
    lastFocusedAt: row.last_focused_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  };
}

function mapHistory(row: HistoryDbRow): BrowserHistoryRow {
  return {
    id: row.id,
    sessionId: row.session_id,
    url: row.url,
    title: row.title,
    seq: row.seq,
    visitCount: row.visit_count,
    typedCount: row.typed_count,
    lastVisitAt: row.last_visit_at,
    firstVisitAt: row.first_visit_at,
    transition: row.transition,
    hidden: row.hidden !== 0,
  };
}

function mapPermission(row: PermissionDbRow): SitePermissionRow {
  return {
    id: row.id,
    origin: row.origin,
    permission: row.permission,
    decision: row.decision,
    scope: row.scope,
    source: row.source,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getSessionById(conn: SqlExecutor, id: string): BrowserSessionRow | undefined {
  const row = conn.get<SessionDbRow>(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?1`, [id]);
  return row === undefined ? undefined : mapSession(row);
}

function getHistoryById(conn: SqlExecutor, id: string): BrowserHistoryRow | undefined {
  const row = conn.get<HistoryDbRow>(`SELECT ${HISTORY_COLUMNS} FROM history WHERE id = ?1`, [id]);
  return row === undefined ? undefined : mapHistory(row);
}

function getPermissionById(conn: SqlExecutor, id: string): SitePermissionRow | undefined {
  const row = conn.get<PermissionDbRow>(
    `SELECT ${PERMISSION_COLUMNS} FROM site_permissions WHERE id = ?1`, [id],
  );
  return row === undefined ? undefined : mapPermission(row);
}

/** Insert or update a session. Unless `isActive === false`, clears other active flags first. */
export function upsertSession(
  db: BrowserDatabase, upsert: BrowserSessionUpsert,
): BrowserSessionRow {
  if (upsert.id.trim() === '') throw browserValidation('session id must not be empty');

  const conn = db.getConn();
  return databaseOperation(() => {
    const now = nowTimestamp();
    const makeActive = upsert.isActive ?? true;
    const existing = getSessionById(conn, upsert.id);

    if (makeActive) {
      conn.run('UPDATE sessions SET is_active = 0 WHERE is_active = 1 AND id != ?1', [upsert.id]);
    }

    if (existing !== undefined) {
      const profileId = upsert.profileId ?? existing.profileId;
      const title = upsert.title ?? existing.title;
      const currentUrl = upsert.currentUrl ?? existing.currentUrl;
      const faviconUrl = upsert.faviconUrl ?? existing.faviconUrl;
      const userAgentOverride = upsert.userAgentOverride ?? existing.userAgentOverride;
      const historyIndex = upsert.historyIndex ?? existing.historyIndex;
      const lastFocusedAt = upsert.lastFocusedAt ?? existing.lastFocusedAt;
      const isActive = makeActive ? 1 : 0;
      conn.run(
        `UPDATE sessions SET
           profile_id = ?2, title = ?3, current_url = ?4, favicon_url = ?5,
           user_agent_override = ?6, history_index = ?7, is_active = ?8,
           last_focused_at = ?9, updated_at = ?10, closed_at = NULL
         WHERE id = ?1`,
        [
          upsert.id, profileId, title, currentUrl, faviconUrl, userAgentOverride,
          historyIndex, isActive, lastFocusedAt, now,
        ],
      );
    } else {
      const profileId = upsert.profileId ?? 'default';
      const historyIndex = upsert.historyIndex ?? -1;
      const isActive = makeActive ? 1 : 0;
      conn.run(
        `INSERT INTO sessions (
           id, profile_id, title, current_url, favicon_url, user_agent_override,
           history_index, is_active, last_focused_at, created_at, updated_at, closed_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, NULL)`,
        [
          upsert.id, profileId, upsert.title ?? null, upsert.currentUrl ?? null,
          upsert.faviconUrl ?? null, upsert.userAgentOverride ?? null, historyIndex,
          isActive, upsert.lastFocusedAt ?? null, now,
        ],
      );
    }

    const row = getSessionById(conn, upsert.id);
    if (row === undefined) throw browserNotFound(`session ${upsert.id}`);
    return row;
  });
}

/** The single active session, if any. */
export function getActive(db: BrowserDatabase): BrowserSessionRow | undefined {
  const conn = db.getConn();
  return databaseOperation(() => {
    const row = conn.get<SessionDbRow>(
      `SELECT ${SESSION_COLUMNS} FROM sessions WHERE is_active = 1 LIMIT 1`,
    );
    return row === undefined ? undefined : mapSession(row);
  });
}

/** Close a session: clear the active flag and record `closed_at`. */
export function closeSession(db: BrowserDatabase, sessionId: string): void {
  const conn = db.getConn();
  databaseOperation(() => {
    const now = nowTimestamp();
    const result = conn.run(
      'UPDATE sessions SET is_active = 0, closed_at = ?2, updated_at = ?2 WHERE id = ?1',
      [sessionId, now],
    );
    if (result.changes === 0) throw browserNotFound(`session ${sessionId}`);
  });
}

/**
 * Append a navigation entry: truncate the forward stack after the current
 * `history_index`, insert the new row, and update the session pointer.
 */
export function pushHistory(
  db: BrowserDatabase, sessionId: string, entry: BrowserHistoryPush,
): BrowserHistoryRow {
  if (entry.url.trim() === '') throw browserValidation('history url must not be empty');

  const conn = db.getConn();
  const id = databaseOperation(() => conn.transaction(tx => {
    const now = nowTimestamp();
    const session = getSessionById(tx, sessionId);
    if (session === undefined) throw browserNotFound(`session ${sessionId}`);

    const currentIndex = session.historyIndex;
    if (currentIndex >= 0) {
      tx.run('DELETE FROM history WHERE session_id = ?1 AND seq > ?2', [sessionId, currentIndex]);
    }

    const nextSeq = currentIndex + 1;
    const historyId = `bh_${randomUUID()}`;
    const typedCount = entry.typed ? 1 : 0;
    tx.run(
      `INSERT INTO history (
         id, session_id, url, title, seq, visit_count, typed_count,
         last_visit_at, first_visit_at, transition, hidden
       ) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7, ?7, ?8, 0)`,
      [
        historyId, sessionId, entry.url, entry.title ?? null, nextSeq, typedCount,
        now, entry.transition ?? null,
      ],
    );

    // Keep persisted seq values aligned with BrowserSession's bounded zero-based
    // in-memory stack. Without rebasing the 51st navigation leaves SQLite at
    // seq=50 while the runtime index has wrapped to 49.
    const overflow = Math.max(nextSeq - MAX_HISTORY + 1, 0);
    const persistedSeq = nextSeq - overflow;
    if (overflow > 0) {
      tx.run('DELETE FROM history WHERE session_id = ?1 AND seq < ?2', [sessionId, overflow]);
      // Rebase in two phases so UNIQUE(session_id, seq) never sees transient collisions.
      tx.run(
        'UPDATE history SET seq = -seq - 1 WHERE session_id = ?1 AND seq IS NOT NULL',
        [sessionId],
      );
      tx.run(
        'UPDATE history SET seq = (-seq - 1) - ?2 WHERE session_id = ?1 AND seq IS NOT NULL',
        [sessionId, overflow],
      );
    }

    tx.run(
      `UPDATE sessions
         SET history_index = ?2, current_url = ?3, title = COALESCE(?4, title),
             updated_at = ?5, closed_at = NULL
       WHERE id = ?1`,
      [sessionId, persistedSeq, entry.url, entry.title ?? null, now],
    );
    return historyId;
  }));

  return databaseOperation(() => {
    const row = getHistoryById(conn, id);
    if (row === undefined) throw browserNotFound(`history ${id}`);
    return row;
  });
}

/** Delete the forward stack and clamp `history_index` to `afterSeq`. */
export function truncateHistoryForward(
  db: BrowserDatabase, sessionId: string, afterSeq: number,
): number {
  const conn = db.getConn();
  return databaseOperation(() => conn.transaction(tx => {
    const now = nowTimestamp();
    const deleted = tx.run(
      'DELETE FROM history WHERE session_id = ?1 AND seq > ?2', [sessionId, afterSeq],
    ).changes;
    tx.run(
      `UPDATE sessions SET history_index = MIN(history_index, ?2), updated_at = ?3
       WHERE id = ?1`,
      [sessionId, afterSeq, now],
    );

    if (afterSeq >= 0) {
      const entry = tx.get<{ url: string; title: string | null }>(
        'SELECT url, title FROM history WHERE session_id = ?1 AND seq = ?2',
        [sessionId, afterSeq],
      );
      if (entry !== undefined) {
        tx.run(
          'UPDATE sessions SET current_url = ?2, title = COALESCE(?3, title) WHERE id = ?1',
          [sessionId, entry.url, entry.title],
        );
      }
    } else {
      tx.run(
        'UPDATE sessions SET current_url = NULL, history_index = -1 WHERE id = ?1',
        [sessionId],
      );
    }
    return deleted;
  }));
}

/**
 * Replace URL/title on the current stack entry and mirror the values to the
 * session row in one transaction (replace navigation, redirects, title changes).
 */
export function updateCurrentHistory(
  db: BrowserDatabase, sessionId: string, historyIndex: number,
  url: string | null, title: string | null,
): void {
  if (historyIndex < 0) throw browserValidation('history index must not be negative');
  if (url === null && title === null) return;

  const conn = db.getConn();
  databaseOperation(() => conn.transaction(tx => {
    const now = nowTimestamp();
    const updated = tx.run(
      `UPDATE history SET
         url = COALESCE(?3, url),
         title = COALESCE(?4, title),
         last_visit_at = CASE WHEN ?3 IS NULL THEN last_visit_at ELSE ?5 END
       WHERE session_id = ?1 AND seq = ?2`,
      [sessionId, historyIndex, url, title, now],
    ).changes;
    if (updated === 0) throw browserNotFound(`history entry ${sessionId}:${historyIndex}`);

    const updatedSession = tx.run(
      `UPDATE sessions SET
         current_url = COALESCE(?3, current_url),
         title = COALESCE(?4, title),
         history_index = ?2,
         updated_at = ?5,
         closed_at = NULL
       WHERE id = ?1`,
      [sessionId, historyIndex, url, title, now],
    ).changes;
    if (updatedSession === 0) throw browserNotFound(`session ${sessionId}`);
  }));
}

/** List history by session (`seq` ascending); without a session, newest visits first. */
export function listHistory(
  db: BrowserDatabase, sessionId: string | null, limit: number | null,
): BrowserHistoryRow[] {
  const conn = db.getConn();
  const effectiveLimit = Math.min(Math.max(limit ?? 500, 1), 5000);
  return databaseOperation(() => {
    if (sessionId !== null) {
      return conn.all<HistoryDbRow>(
        `SELECT ${HISTORY_COLUMNS} FROM history
         WHERE session_id = ?1
         ORDER BY seq ASC
         LIMIT ?2`,
        [sessionId, effectiveLimit],
      ).map(mapHistory);
    }
    return conn.all<HistoryDbRow>(
      `SELECT ${HISTORY_COLUMNS} FROM history
       ORDER BY last_visit_at DESC
       LIMIT ?1`,
      [effectiveLimit],
    ).map(mapHistory);
  });
}

export function getSetting(db: BrowserDatabase, key: string): BrowserSettingRow | undefined {
  const conn = db.getConn();
  return databaseOperation(() => {
    const row = conn.get<SettingDbRow>(
      'SELECT key, value, updated_at FROM settings WHERE key = ?1', [key],
    );
    return row === undefined
      ? undefined
      : { key: row.key, value: row.value, updatedAt: row.updated_at };
  });
}

export function setSetting(db: BrowserDatabase, key: string, value: string): void {
  if (key.trim() === '') throw browserValidation('setting key must not be empty');
  const conn = db.getConn();
  databaseOperation(() => {
    conn.run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, value, nowTimestamp()],
    );
  });
}

export function upsertSitePermission(
  db: BrowserDatabase, upsert: SitePermissionUpsert,
): SitePermissionRow {
  if (upsert.origin.trim() === '' || upsert.permission.trim() === '') {
    throw browserValidation('origin and permission are required');
  }

  const conn = db.getConn();
  return databaseOperation(() => {
    const now = nowTimestamp();
    const scope = upsert.scope ?? 'origin';
    const source = upsert.source ?? 'user';
    const existing = conn.get<{ id: string }>(
      'SELECT id FROM site_permissions WHERE origin = ?1 AND permission = ?2',
      [upsert.origin, upsert.permission],
    );

    let id: string;
    if (existing !== undefined) {
      id = existing.id;
      conn.run(
        `UPDATE site_permissions SET
           decision = ?2, scope = ?3, source = ?4,
           expires_at = ?5, updated_at = ?6
         WHERE id = ?1`,
        [id, upsert.decision, scope, source, upsert.expiresAt ?? null, now],
      );
    } else {
      id = `bsp_${randomUUID()}`;
      conn.run(
        `INSERT INTO site_permissions (
           id, origin, permission, decision, scope, source,
           expires_at, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`,
        [
          id, upsert.origin, upsert.permission, upsert.decision, scope, source,
          upsert.expiresAt ?? null, now,
        ],
      );
    }

    const row = getPermissionById(conn, id);
    if (row === undefined) throw browserNotFound(`site_permission ${id}`);
    return row;
  });
}

export function getSitePermission(
  db: BrowserDatabase, origin: string, permission: string,
): SitePermissionRow | undefined {
  const conn = db.getConn();
  return databaseOperation(() => {
    const row = conn.get<PermissionDbRow>(
      `SELECT ${PERMISSION_COLUMNS} FROM site_permissions
       WHERE origin = ?1 AND permission = ?2`,
      [origin, permission],
    );
    return row === undefined ? undefined : mapPermission(row);
  });
}
